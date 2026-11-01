export interface MemoryFrontmatter {
  body: string;
  raw: string;
  [key: string]: string | undefined;
}

export interface LintOptions {
  repo?: string;
}
