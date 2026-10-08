---
title: '서비스 병합이 QA에서만 gRPC 500을 만든 이유: Service alias와 DestinationRule의 생명주기'
description: 'Friend 서비스를 Social로 병합하는 과정에서 Kubernetes Service 호환 alias만 남고 Istio DestinationRule이 빠져 QA에서만 gRPC 응답이 깨졌다. 환경별 차이를 추적하고 두 리소스의 생성 조건과 제거 시점을 맞춘 과정을 정리한다.'
pubDate: 'Oct 8 2026'
---

서비스 두 개를 하나로 합칠 때 코드만 옮기면 끝날 것 같지만, 실제 전환에는 호출 주소와 배포 순서가 남는다. 이번 장애도 비즈니스 로직이 아니라 **병합 도중 유지한 호환 주소의 리소스가 절반만 만들어진 것**에서 시작됐다.

Friend 서비스의 기능을 Social 서비스로 옮긴 뒤 QA의 계정 상세 페이지가 500을 반환했다. 같은 화면이 다른 환경에서는 잘 열렸고, Social의 다른 RPC도 정상이라 처음에는 특정 Friend RPC 구현을 의심했다. 하지만 실제 원인은 Kubernetes `Service`와 Istio `DestinationRule`의 생성 조건이 어긋난 것이었다.

## 증상: 같은 코드인데 QA에서만 실패했다

실패한 요청은 Hiker에서 SBX Server를 거쳐 Friend 계열 gRPC를 호출하는 경로였다. 애플리케이션 로그만 보면 Social Pod까지 요청이 도달했고 핸들러도 응답을 만들었다. 그런데 클라이언트가 받은 결과는 500이었다.

여기서 중요한 단서는 세 가지였다.

- QA에서만 실패했다.
- Social이 직접 소유한 다른 RPC는 정상이었다.
- 실패한 RPC는 과거 Friend 서비스가 제공하던 API였다.

코드가 같고 환경만 다르면 배포된 리소스부터 비교해야 한다. QA에서는 Friend 서비스 병합이 끝나 `friend_service`가 서비스 목록에서 빠져 있었고, 다른 환경에는 아직 독립 Friend 서비스가 남아 있었다.

## 병합 과정에 남겨 둔 `friend` 호환 주소

Friend API 구현과 API binding은 이미 Social로 옮겨진 상태였다. 새 버전 Server Pod는 Friend API가 Social에 있다는 것을 알고 `social` 주소를 사용한다.

문제는 롤링 배포 중 함께 떠 있을 수 있는 구버전 Pod다. 구버전은 여전히 Friend API를 `friend` 주소로 호출할 수 있다. 이를 위해 Helm chart에는 Social이 배포될 때 `Service/social`뿐 아니라 Social Pod를 선택하는 `Service/friend`도 만드는 분기가 있었다.

```gotemplate
{{- $hosts := list $host }}
{{- if eq $serviceName "social_service" }}
  {{- $hosts = append $hosts "friend" }}
{{- end }}
```

이 alias가 있으면 전환 중 호출은 다음처럼 이어진다.

```text
구버전 Server Pod
        │  friend:23000
        ▼
 Service/friend
        │  selector: Social
        ▼
    Social Pod
```

이 코드는 영구적인 서비스 이름을 하나 더 만든 것이 아니다. **구버전 호출자가 사라질 때까지 유지하는 롤링 배포용 호환 계층**이었다.

## 빠진 절반: `DestinationRule/friend`

Kubernetes Service를 추가하면 `friend`라는 주소로 Social Pod까지 패킷을 보낼 수 있다. 그러나 서비스 메시 안에서 새 host를 추가하는 일은 DNS와 selector만의 문제가 아니다. Envoy는 host별 `DestinationRule`을 바탕으로 연결과 프로토콜 정책을 구성한다.

기존 chart는 실제 서비스 목록을 순회하며 DestinationRule을 만들었다.

```text
Service/social           있음
DestinationRule/social   있음

Service/friend           있음  ← Social이 추가로 만든 alias
DestinationRule/friend   없음  ← 실제 서비스 목록에는 Friend가 없음
```

QA에서는 `friend_service`가 목록에서 제거됐기 때문에 이 불일치가 드러났다. `friend` host에 Social과 같은 `useClientProtocol` 정책이 적용되지 않았고, Envoy를 통과한 gRPC 응답의 종료 상태와 trailer가 정상적으로 전달되지 않았다. 서버 핸들러는 성공했지만 호출자는 정상 gRPC 응답으로 해석하지 못해 최종 HTTP 요청이 500이 됐다.

반면 Friend가 아직 독립 서비스로 존재하는 환경은 공통 반복문이 `Service/friend`와 `DestinationRule/friend`를 모두 만들었다. 같은 chart를 사용해도 서비스 목록이 달랐기 때문에 증상이 재현되지 않았다.

## 왜 Friend RPC만 실패했나

이 문제는 Social Pod 전체의 장애가 아니었다. Istio 정책은 목적지 host를 기준으로 적용되므로 같은 Pod로 들어가는 요청도 호출 주소에 따라 다른 구성을 사용할 수 있다.

```text
social:23000 → DestinationRule/social 적용 → 정상
friend:23000 → DestinationRule/friend 없음 → gRPC 응답 처리 실패
```

그래서 Social의 다른 RPC와 Account 같은 다른 서비스는 정상이고, `friend` host를 사용한 RPC만 실패했다. Pod와 포트가 같다는 사실만으로 서비스 메시의 동작까지 같아지지는 않는다.

## 진단 순서

애플리케이션 코드부터 깊게 파기 전에 환경별 선언과 Envoy 설정을 비교하면 범위를 빠르게 줄일 수 있다.

### 1. 환경별 Service와 DestinationRule을 나란히 본다

```bash
kubectl -n <namespace> get service friend social
kubectl -n <namespace> get destinationrule friend social
```

Service는 있는데 같은 host의 DestinationRule이 없다면 chart의 생성 조건을 확인한다. 특히 서비스 병합이나 이름 변경 직후라면 실제 서비스와 호환 alias를 구분해야 한다.

### 2. selector가 어느 Pod를 가리키는지 확인한다

```bash
kubectl -n <namespace> get service friend -o yaml
kubectl -n <namespace> get endpoints friend -o yaml
```

`Service/friend`의 endpoint가 Social Pod라면 현재 `friend`는 독립 서비스가 아니라 alias다.

### 3. Envoy의 host별 cluster 설정을 비교한다

`social`과 `friend` cluster의 HTTP/2 및 downstream protocol 관련 설정을 비교한다. 같은 endpoint를 가리켜도 host별 정책이 다르면 Envoy cluster 구성도 달라진다.

### 4. HTTP status만 보지 말고 gRPC trailer까지 확인한다

gRPC는 최종 상태를 trailer의 `grpc-status`로 전달한다. 서버 로그의 handler success나 HTTP 200만으로 성공을 판단하면 중간 프록시에서 발생한 종료 처리 문제를 놓칠 수 있다.

수정 배포 후에는 `DestinationRule/friend`가 생성되고 Envoy에 기대한 protocol 설정이 반영됐으며, 문제가 됐던 RPC가 `grpc-status: 0`으로 끝나는 것을 확인했다.

## 수정: 두 리소스를 같은 조건으로 생성한다

당장의 선택지는 두 가지였다.

1. 더 이상 필요하지 않은 `Service/friend`를 제거한다.
2. 전환 기간에는 `DestinationRule/friend`를 함께 만든다.

호출 코드를 조사해보니 현재 버전은 이미 Social을 사용하고 있었다. 하지만 롤링 배포 중 구버전 Server Pod가 남을 가능성 때문에 alias가 추가됐다는 원래 목적까지 고려하면 즉시 제거는 배포 순서에 의존한다. 따라서 전환 기간에는 두 리소스를 쌍으로 유지하기로 했다.

```gotemplate
{{- $clusterServices := (...).services }}
{{- $hosts := list $host }}
{{- if and
      (eq $serviceName "social_service")
      (not (has "friend_service" $clusterServices)) }}
  {{- $hosts = append $hosts "friend" }}
{{- end }}
```

같은 `$hosts` 생성 규칙을 Service와 DestinationRule 양쪽에 적용했다. 추가로 `friend_service`가 실제로 존재하는 환경에서는 alias를 만들지 않도록 조건을 맞췄다.

| 환경 상태 | `Service/friend` | `DestinationRule/friend` |
|---|---|---|
| 독립 Friend 운영 중 | 실제 Friend 대상으로 생성 | 실제 Friend host로 생성 |
| Friend 제거, Social로 병합 | Social 대상 alias 생성 | alias host 정책 생성 |

이렇게 하면 아직 Friend를 운영하는 환경과 이미 병합한 환경이 같은 chart를 사용해도 리소스가 중복되지 않는다.

## 언제 alias를 제거해야 하나

호환 리소스는 추가할 때보다 제거 조건이 더 중요하다. 서비스 병합과 리소스 삭제를 한 번의 배포로 처리하면 롤링 중인 구버전 Pod가 갈 곳을 잃는다.

안전한 전환 순서는 다음과 같다.

1. Friend API binding이 Social을 가리키는 Server 버전을 모든 환경에 배포한다.
2. 구버전 Pod가 모두 종료될 때까지 기다린다.
3. 메트릭과 Envoy access log에서 `friend` host 트래픽이 사라졌는지 확인한다.
4. `Service/friend`와 `DestinationRule/friend`를 함께 제거한다.
5. 실제 Friend Deployment와 환경별 서비스 상태도 정리한다.

핵심은 **코드 전환 완료와 인프라 호환 계층 제거를 별개의 단계로 취급하는 것**이다.

## 남은 교훈

### 호환 alias도 하나의 계약이다

기존 주소를 새 Pod로 연결하는 순간 그 주소는 이름만 남은 것이 아니다. DNS, Service selector, DestinationRule, VirtualService, 네트워크 정책, 모니터링이 함께 움직여야 하는 하나의 계약이 된다.

### 생성 조건을 복사하지 말고 생명주기를 맞춰야 한다

이번 문제의 직접 원인은 Service와 DestinationRule이 서로 다른 서비스 집합을 보고 생성된 것이었다. 관련 리소스는 같은 조건에서 만들어지고 같은 조건에서 제거돼야 한다. 조건을 별도 파일에 복사할 때는 두 템플릿의 결과가 환경별로 대칭인지 확인해야 한다.

### "QA에서만"은 코드보다 전환 상태를 먼저 보라는 신호다

서비스 병합은 환경마다 다른 속도로 진행된다. 코드 SHA가 같아도 서비스 목록, 이전 Deployment의 존재 여부, mesh resource가 다르면 네트워크 경로가 달라진다. 특정 환경에서만 발생하는 장애라면 환경별 리소스 매트릭스를 먼저 그리는 것이 빠르다.

### gRPC 장애는 trailer까지 봐야 한다

요청이 Pod에 도착했고 handler가 성공했다고 해서 호출 전체가 성공한 것은 아니다. gRPC는 프록시의 HTTP/2 처리와 trailer 전달에 의존한다. 서비스 메시를 경유하는 장애에서는 `grpc-status`, protocol negotiation, Envoy cluster 설정을 함께 확인해야 한다.

서비스를 합치는 작업은 코드를 옮기는 순간 끝나지 않는다. 마지막 구버전 호출자가 사라지고, 그 호출자를 위해 만들었던 Service와 DestinationRule을 함께 걷어낼 때 비로소 끝난다.
