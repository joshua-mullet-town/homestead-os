export interface ProjectInfo {
  name: string;
  path: string;
  type: 'nextjs' | 'node' | 'other';
  hasDevScript: boolean;
  devPort?: number;
}

export interface ServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
}

export interface GitData {
  branch: string;
  files: { file: string; status: string; additions: number; deletions: number }[];
  summary: { totalFiles: number; totalAdditions: number; totalDeletions: number };
}

export interface SubstewardData {
  id: string;
  parentId: string;
  name: string;
  type: string;
  shorthand: string;
  icon?: string;
  color: string;
  domain?: string;
}

export interface StewardData {
  id: string;
  name: string;
  type: string;
  shorthand: string;  // up to 4 chars
  icon?: string;       // emoji icon
  color: string;
  stewInt?: string;     // custom StewInt component name (e.g. "SchedulerInt")
  substewards?: SubstewardData[];
  buildData?: {
    project: string;
    codeDir: string;
    worktreeDir: string;
    builds: StewardBuild[];
  };
}

export interface StewardBuild {
  branch: string;
  worktree: string;
  issue?: string;
  created: string;
  status: 'active' | 'archived';
  archivedAt?: string;
}
