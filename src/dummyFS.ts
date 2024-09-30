import {
  Disposable,
  Event,
  EventEmitter,
  FileChangeEvent,
  FileStat,
  FileSystemProvider,
  FileType,
  Uri,
} from "vscode";

export class DummyFS implements FileSystemProvider {
  stat(uri: Uri): FileStat {
    return {
      type: FileType.File,
      ctime: 0,
      mtime: 0,
      size: 0,
    };
  }
  readDirectory(uri: Uri): [string, FileType][] {
    return [];
  }
  readFile(uri: Uri): Uint8Array {
    return Buffer.from(`rg> ${uri.query}\n\n`);
  }
  writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): void {}
  rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean }): void {}
  delete(uri: Uri): void {}
  createDirectory(uri: Uri): void {}

  private _emitter = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> = this._emitter.event;

  watch(_resource: Uri): Disposable {
    return new Disposable(() => {});
  }
}
