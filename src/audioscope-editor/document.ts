import * as vscode from 'vscode';

export class AudioscopeDocument implements vscode.CustomDocument {
  private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidDispose = this.onDidDisposeEmitter.event;

  private constructor(public readonly uri: vscode.Uri) {}

  public static async create(uri: vscode.Uri): Promise<AudioscopeDocument> {
    return new AudioscopeDocument(uri);
  }

  public dispose(): void {
    this.onDidDisposeEmitter.fire();
    this.onDidDisposeEmitter.dispose();
  }
}
