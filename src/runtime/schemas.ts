import { z } from 'zod';

export const ProjectInputSchema = z.object({
  name: z.string().min(1),
  rootPath: z.string().min(1),
  specificationPath: z.string().min(1),
});

export type ProjectInput = z.infer<typeof ProjectInputSchema>;

export const SpecificationSchema = z.object({
  content: z.string().min(1),
  hash: z.string().optional(),
});

export type Specification = z.infer<typeof SpecificationSchema>;
