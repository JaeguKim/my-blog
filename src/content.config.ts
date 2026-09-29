import { type SchemaContext, defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const schema = ({ image }: SchemaContext) =>
	z.object({
		title: z.string(),
		description: z.string(),
		// Transform string to Date object
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		heroImage: image().optional(),
	});

// Korean originals. Load Markdown and MDX files in the `src/content/blog/` directory.
const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema,
});

// English translations, matched to the originals by file name (id).
const blogEn = defineCollection({
	loader: glob({ base: './src/content/blog-en', pattern: '**/*.{md,mdx}' }),
	schema,
});

export const collections = { blog, blogEn };
