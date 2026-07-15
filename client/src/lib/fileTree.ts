/** One entry in the editor's file tree. Directories have `children`. */
export interface FileNode {
  /** Display segment, e.g. "intro.tex". */
  name: string;
  /** Full project-relative path, e.g. "sections/intro.tex". */
  path: string;
  /** True for files that exist only server-side (e.g. figures from run_python). */
  generated?: boolean;
  children?: FileNode[];
}

interface DirBuild {
  dirs: Map<string, DirBuild>;
  files: FileNode[];
}

/**
 * Merge the editable project files, the server-side session files (generated
 * figures, …), and bare directories (so EMPTY folders show) into one
 * directory tree. Directories sort first, then files alphabetically, with
 * main.tex pinned to the top of the root.
 */
export function buildFileTree(
  editable: string[],
  generated: string[],
  dirs: string[] = [],
): FileNode[] {
  const root: DirBuild = { dirs: new Map(), files: [] };
  const descend = (parts: string[]): DirBuild => {
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    return dir;
  };
  const insert = (p: string, gen: boolean) => {
    const parts = p.split("/").filter(Boolean);
    if (parts.length === 0) return;
    const dir = descend(parts.slice(0, -1));
    const name = parts[parts.length - 1];
    if (!dir.files.some((f) => f.name === name)) {
      dir.files.push({ name, path: parts.join("/"), ...(gen ? { generated: true } : {}) });
    }
  };
  for (const d of dirs) descend(d.split("/").filter(Boolean));
  for (const p of editable) insert(p, false);
  const editableSet = new Set(editable);
  for (const p of generated) if (!editableSet.has(p)) insert(p, true);

  const toNodes = (dir: DirBuild, prefix: string, atRoot: boolean): FileNode[] => {
    const dirNodes = [...dir.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]) => ({
        name,
        path: prefix + name,
        children: toNodes(sub, `${prefix}${name}/`, false),
      }));
    const fileNodes = [...dir.files].sort((a, b) => {
      if (atRoot && a.name === "main.tex") return -1;
      if (atRoot && b.name === "main.tex") return 1;
      return a.name.localeCompare(b.name);
    });
    return [...dirNodes, ...fileNodes];
  };
  return toNodes(root, "", true);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

/** Whether a file should preview as an image (vs text/other embed). */
export function isImageFile(path: string): boolean {
  return IMAGE_EXT.test(path);
}
