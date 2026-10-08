---
title: 'Why a Service Merge Caused gRPC 500s Only in QA: The Lifecycle of Service Aliases and DestinationRules'
description: 'During a Friend-to-Social service merge, a Kubernetes Service compatibility alias remained without a matching Istio DestinationRule. This post explains why only QA and Friend RPCs failed, how we traced it, and how to keep migration resources in sync.'
pubDate: 'Oct 8 2026'
---

Merging two services can look like a code move, but the transition also includes call addresses and deployment order. This incident started because **only half of a compatibility address survived the merge**.

After moving Friend functionality into Social, an account detail page returned 500 in QA. The same page worked in other environments, and other Social RPCs were healthy, so the first suspicion was a bug in a particular Friend RPC. The actual cause was a mismatch between the generation conditions for a Kubernetes `Service` and an Istio `DestinationRule`.

## The Symptom: The Same Code Failed Only in QA

The failing path called a Friend gRPC API through our Server. Application logs showed that the request reached a Social Pod and that the handler produced a response. The client still received a 500.

Three details narrowed the search:

- The failure occurred only in QA.
- RPCs originally owned by Social still worked.
- The failing RPC used to be served by Friend.

When code is identical and only the environment differs, deployed resources are the next thing to compare. QA had completed the Friend merge and removed `friend_service` from its service list. Other environments still had a standalone Friend service.

## The `friend` Compatibility Address

The Friend implementation and API bindings had already moved into Social. New Server Pods knew that Friend APIs belonged to Social and used the `social` address.

Old Pods can coexist with new Pods during a rolling deployment. Those old Pods may still call Friend APIs through the `friend` address. To support them, the Helm chart created both `Service/social` and `Service/friend`, with the latter selecting Social Pods.

```gotemplate
{{- $hosts := list $host }}
{{- if eq $serviceName "social_service" }}
  {{- $hosts = append $hosts "friend" }}
{{- end }}
```

The transition path looked like this:

```text
Old Server Pod
      │  friend:23000
      ▼
Service/friend
      │  selector: Social
      ▼
  Social Pod
```

This alias was not a permanent second service name. It was a **rolling-deployment compatibility layer** meant to live until old callers disappeared.

## The Missing Half: `DestinationRule/friend`

A Kubernetes Service makes the Social Pods reachable through the `friend` address. In a service mesh, however, adding a host involves more than DNS and selectors. Envoy builds connection and protocol behavior for each host from resources such as DestinationRules.

The existing chart created DestinationRules by iterating over the list of real services.

```text
Service/social           present
DestinationRule/social   present

Service/friend           present  ← compatibility alias created by Social
DestinationRule/friend   missing  ← Friend was absent from the real service list
```

QA exposed this mismatch because `friend_service` had already been removed from its list. The `friend` host did not receive the same `useClientProtocol` policy as Social. The gRPC completion status and trailers were not propagated correctly through Envoy. The server handler succeeded, but the caller could not interpret the result as a valid completed gRPC response, and the outer HTTP request ended as a 500.

Environments that still ran Friend did not fail. Their common service loop generated both `Service/friend` and `DestinationRule/friend` for the real Friend service. The chart was the same, but the service list put each environment in a different migration state.

## Why Only Friend RPCs Failed

This was not an outage of the Social Pods. Istio applies policy by destination host, so two requests reaching the same Pods can use different Envoy configurations when their hostnames differ.

```text
social:23000 → DestinationRule/social applied → healthy
friend:23000 → no DestinationRule/friend      → broken gRPC completion
```

That is why other Social RPCs and unrelated services such as Account remained healthy. Only calls through the `friend` host failed. Sharing Pods and ports does not make two service-mesh hosts equivalent.

## A Practical Diagnostic Sequence

Before diving deep into application code, comparing environment declarations and Envoy configuration can reduce the search space quickly.

### 1. Compare Services and DestinationRules Side by Side

```bash
kubectl -n <namespace> get service friend social
kubectl -n <namespace> get destinationrule friend social
```

If a Service exists without a DestinationRule for the same host, inspect the chart conditions. After a merge or rename, distinguish real services from compatibility aliases.

### 2. Check Which Pods the Selector Targets

```bash
kubectl -n <namespace> get service friend -o yaml
kubectl -n <namespace> get endpoints friend -o yaml
```

If `Service/friend` resolves to Social Pods, `friend` is now an alias rather than an independent service.

### 3. Compare Envoy Clusters by Host

Compare the HTTP/2 and downstream protocol settings for the `social` and `friend` clusters. Even with identical endpoints, host-specific policies can produce different Envoy cluster configurations.

### 4. Inspect gRPC Trailers, Not Just HTTP Status

gRPC communicates its final result through the `grpc-status` trailer. A successful handler log or an intermediate HTTP 200 is not enough to prove end-to-end success. A proxy can break the completion path after the handler has returned.

After deployment of the fix, `DestinationRule/friend` existed, Envoy contained the expected protocol settings, and the failing RPC completed with `grpc-status: 0`.

## The Fix: Generate Both Resources Under the Same Condition

There were two possible fixes:

1. Remove `Service/friend` if it was no longer needed.
2. Keep the alias during migration and generate `DestinationRule/friend` with it.

Current code already routed Friend bindings to Social. However, removing the alias immediately would make safety depend on deployment order because old Server Pods might still use it during a rollout. We kept both resources for the transition period.

```gotemplate
{{- $clusterServices := (...).services }}
{{- $hosts := list $host }}
{{- if and
      (eq $serviceName "social_service")
      (not (has "friend_service" $clusterServices)) }}
  {{- $hosts = append $hosts "friend" }}
{{- end }}
```

We applied the same host-generation rule to both the Service and DestinationRule templates. We also avoided creating the alias when a real `friend_service` was still present.

| Environment state | `Service/friend` | `DestinationRule/friend` |
|---|---|---|
| Standalone Friend still running | Targets real Friend | Policy for real Friend host |
| Friend removed and merged into Social | Alias targeting Social | Policy for alias host |

This lets environments at different migration stages share one chart without creating duplicate resources.

## When to Remove the Alias

The removal condition matters more than the addition itself. Removing service resources in the same deployment that changes callers can leave old Pods without a valid destination during a rollout.

A safe sequence is:

1. Deploy a Server version whose Friend API bindings point to Social in every environment.
2. Wait until all old Pods have terminated.
3. Confirm through metrics and Envoy access logs that traffic to the `friend` host has stopped.
4. Remove `Service/friend` and `DestinationRule/friend` together.
5. Clean up the real Friend Deployment and environment service state.

Treating **code cutover and infrastructure compatibility cleanup as separate deployment stages** is the key.

## Lessons

### A Compatibility Alias Is Still a Contract

Once an old address points to new Pods, it is more than a DNS name. DNS, Service selectors, DestinationRules, VirtualServices, network policy, and monitoring form one compatibility contract.

### Related Resources Need the Same Lifecycle

The direct cause was that Service and DestinationRule generation used different host sets. Related resources should be created and removed under the same conditions. When conditions are repeated across template files, render the chart for every migration state and check that the outputs remain symmetric.

### “Only in QA” Often Means “Different Migration State”

Service merges progress at different speeds across environments. Identical code SHAs do not guarantee identical network paths when service lists, old Deployments, and mesh resources differ. For an environment-specific failure, draw a resource matrix before blaming the handler.

### A gRPC Investigation Must Include Trailers

The request reaching a Pod and the handler succeeding do not prove the full call succeeded. gRPC depends on HTTP/2 behavior and trailer propagation through every proxy. Check `grpc-status`, protocol negotiation, and Envoy cluster configuration together.

A service merge is not complete when the code has moved. It is complete when the final old caller is gone and the Service and DestinationRule that supported it can be removed together.
