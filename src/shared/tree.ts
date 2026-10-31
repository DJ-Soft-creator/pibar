// Pure helper for the file tree on the right: turn relative paths ("a/b.md") into nested folders.

export interface TreeDir {
  name: string;
  /** Path relative to the root folder, "" for the root itself */
  path: string;
  dirs: TreeDir[];
  files: { name: string; path: string }[];
}

/** Build a tree from relative paths ("a/b.md"; folders end with "/"); folders first, both sorted by name */
export function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  for (const p of paths) {
    const isDir = p.endsWith("/");
    const parts = p.split("/").filter(Boolean);
    if (!parts.length) continue;
    let dir = root;
    for (const part of isDir ? parts : parts.slice(0, -1)) {
      let next = dir.dirs.find((d) => d.name === part);
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
    }
    if (isDir) continue;
    const name = parts[parts.length - 1];
    dir.files.push({ name, path: dir.path ? `${dir.path}/${name}` : name });
  }
  const sort = (d: TreeDir) => {
    const cmp = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name, undefined, { numeric: true });
    d.dirs.sort(cmp);
    d.files.sort(cmp);
    d.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

/** Number of files in a folder including subfolders */
export function countFiles(d: TreeDir): number {
  return d.files.length + d.dirs.reduce((n, x) => n + countFiles(x), 0);
}
