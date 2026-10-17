import type { ValidationIssue } from '@bpmn-flow/core';
import type { BpmnEditor } from '@bpmn-flow/editor';

interface WritableFile {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface LocalFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFile>;
}

interface FilePickerOptions {
  types: { description: string; accept: Record<string, string[]> }[];
  suggestedName?: string;
  multiple?: boolean;
}

interface PickerWindow extends Window {
  showOpenFilePicker?: (options: FilePickerOptions) => Promise<LocalFileHandle[]>;
  showSaveFilePicker?: (options: FilePickerOptions) => Promise<LocalFileHandle>;
}

interface StudioElements {
  canvas: HTMLElement;
  empty: HTMLElement;
  fileInput: HTMLInputElement;
  fileName: HTMLElement;
  status: HTMLElement;
  issueCount: HTMLElement;
  issues: HTMLElement;
  create: HTMLButtonElement;
  open: HTMLButtonElement;
  openEmpty: HTMLButtonElement;
  validate: HTMLButtonElement;
  save: HTMLButtonElement;
  saveCopy: HTMLButtonElement;
}

type Editor = InstanceType<typeof BpmnEditor>;

/** Browser file and editor lifecycle for the local BPMN Studio. */
export class StudioWorkspace {
  private editor?: Editor;
  private stopListening?: () => void;
  private handle?: LocalFileHandle;
  private fileName?: string;
  private diskBaseline?: string;
  private dirty = false;
  private hasDiagram = false;
  private suppressChanges = false;
  private busy = false;
  private initialization?: Promise<void>;

  constructor(
    private readonly elements: StudioElements,
    private readonly onError: (error: unknown) => void,
  ) {
    elements.create.addEventListener('click', () => void this.run(() => this.createDiagram()));
    elements.open.addEventListener('click', () => void this.run(() => this.openFile()));
    elements.openEmpty.addEventListener('click', () => void this.run(() => this.openFile()));
    elements.validate.addEventListener('click', () => void this.run(() => this.validate()));
    elements.save.addEventListener('click', () => void this.run(() => this.save()));
    elements.saveCopy.addEventListener('click', () => void this.run(() => this.saveCopy()));
    elements.fileInput.addEventListener('change', () => {
      const file = elements.fileInput.files?.[0];
      elements.fileInput.value = '';
      if (file) void this.run(() => this.loadFile(file));
    });
    window.addEventListener('beforeunload', this.guardUnload);
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async enter(): Promise<void> {
    if (this.editor) {
      if (this.hasDiagram) this.editor.fit();
      return;
    }
    if (!this.initialization) this.initialization = this.initializeEditor();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private async initializeEditor(): Promise<void> {
    await import('@bpmn-flow/editor/styles.css');
    const { BpmnEditor: EditorClass } = await import('@bpmn-flow/editor');
    this.editor = new EditorClass(this.elements.canvas);
    this.stopListening = this.editor.onChange(() => {
      if (this.suppressChanges) return;
      this.dirty = true;
      this.elements.issues.replaceChildren();
      this.elements.issueCount.textContent = '—';
      this.setDocumentStatus('Alterações não salvas', 'dirty');
    });
    this.updateControls();
  }

  confirmDiscard(): boolean {
    return !this.dirty || window.confirm('Há alterações não salvas. Descartar o trabalho?');
  }

  discard(): void {
    this.stopListening?.();
    this.editor?.destroy();
    this.editor = undefined;
    this.stopListening = undefined;
    this.handle = undefined;
    this.fileName = undefined;
    this.diskBaseline = undefined;
    this.dirty = false;
    this.hasDiagram = false;
    this.elements.canvas.replaceChildren();
    this.elements.canvas.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.fileName.textContent = 'Nenhum arquivo aberto';
    this.elements.status.textContent = 'Crie um diagrama ou abra um arquivo BPMN.';
    this.elements.status.className = 'studio-status';
    this.elements.issues.replaceChildren();
    this.elements.issueCount.textContent = '0';
    this.elements.saveCopy.hidden = true;
    this.updateControls();
  }

  private readonly guardUnload = (event: BeforeUnloadEvent): void => {
    if (!this.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.updateControls();
    try {
      await action();
    } catch (error) {
      if (!this.isAbort(error)) this.onError(error);
    } finally {
      this.busy = false;
      this.updateControls();
    }
  }

  private async createDiagram(): Promise<void> {
    if (!this.confirmDiscard()) return;
    await this.enter();
    const editor = this.requireEditor();
    this.elements.canvas.hidden = false;
    this.elements.empty.hidden = true;
    this.suppressChanges = true;
    try {
      await editor.newDiagram();
    } finally {
      this.suppressChanges = false;
    }
    this.handle = undefined;
    this.fileName = undefined;
    this.diskBaseline = undefined;
    this.hasDiagram = true;
    this.dirty = true;
    this.elements.fileName.textContent = 'Novo diagrama';
    this.elements.saveCopy.hidden = true;
    this.elements.issues.replaceChildren();
    this.elements.issueCount.textContent = '—';
    this.setDocumentStatus('Diagrama novo · alterações não salvas', 'dirty');
    this.updateControls();
  }

  private async openFile(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const browser = window as PickerWindow;
    if (browser.showOpenFilePicker) {
      const [handle] = await browser.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'BPMN XML', accept: { 'application/xml': ['.bpmn', '.xml'] } }],
      });
      if (!handle) return;
      await this.loadFromHandle(handle);
      return;
    }
    this.elements.fileInput.click();
  }

  private async loadFile(file: File): Promise<void> {
    const xml = await file.text();
    await this.load(xml, file.name, undefined);
  }

  private async loadFromHandle(handle: LocalFileHandle): Promise<void> {
    const file = await handle.getFile();
    await this.load(await file.text(), file.name, handle);
  }

  private async load(
    xml: string,
    name: string,
    handle: LocalFileHandle | undefined,
  ): Promise<void> {
    await this.enter();
    const editor = this.requireEditor();
    this.elements.canvas.hidden = false;
    this.elements.empty.hidden = true;
    this.suppressChanges = true;
    try {
      await editor.open(xml);
    } catch (error) {
      this.elements.canvas.hidden = !this.hasDiagram;
      this.elements.empty.hidden = this.hasDiagram;
      throw error;
    } finally {
      this.suppressChanges = false;
    }
    this.handle = handle;
    this.fileName = name;
    this.diskBaseline = xml;
    this.hasDiagram = true;
    this.dirty = false;
    this.elements.fileName.textContent = name;
    this.elements.issues.replaceChildren();
    this.elements.issueCount.textContent = '—';
    this.elements.saveCopy.hidden = true;
    this.setDocumentStatus(
      handle
        ? 'Arquivo aberto · alterações sincronizadas com o disco'
        : 'Arquivo aberto · salvar baixa uma cópia',
      'saved',
    );
    this.updateControls();
  }

  private async validate(): Promise<void> {
    if (!this.hasDiagram) return;
    const result = await this.requireEditor().validate();
    this.elements.issues.replaceChildren();
    this.elements.issueCount.textContent = String(result.issues.length);
    for (const issue of result.issues) this.elements.issues.append(this.issueItem(issue));
    const errors = result.issues.filter((issue) => issue.severity === 'error').length;
    const warnings = result.issues.length - errors;
    const summary = `${errors} erro(s) · ${warnings} aviso(s)`;
    const savedState = this.dirty ? 'dirty' : 'saved';
    this.setDocumentStatus(
      `${result.valid ? 'Validação concluída' : 'Validação falhou'} · ${summary}${this.dirty ? ' · alterações não salvas' : ''}`,
      result.valid ? savedState : 'error',
    );
  }

  private issueItem(issue: ValidationIssue): HTMLLIElement {
    const item = document.createElement('li');
    item.className = `studio-issue ${issue.severity}`;
    if (issue.nodeId) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'studio-issue-link';
      link.textContent = issue.message;
      link.title = `Selecionar elemento ${issue.nodeId}`;
      link.addEventListener('click', () => {
        if (!this.requireEditor().focusElement(issue.nodeId ?? '')) {
          this.onError(new Error(`O elemento ${issue.nodeId} não está no diagrama aberto.`));
        }
      });
      item.append(link, this.nodeReference(issue.nodeId));
    } else {
      const message = document.createElement('span');
      message.textContent = issue.message;
      item.append(message);
    }
    return item;
  }

  private nodeReference(id: string): HTMLElement {
    const reference = document.createElement('code');
    reference.className = 'studio-node-reference';
    reference.textContent = id;
    return reference;
  }

  private async save(): Promise<void> {
    if (!this.hasDiagram) return;
    const xml = await this.requireEditor().getXml();
    if (!this.handle) {
      this.download(xml);
      this.markSaved(xml, undefined, this.fileName ?? 'process.bpmn');
      return;
    }

    const currentDisk = await this.handle.getFile();
    if ((await currentDisk.text()) !== this.diskBaseline) {
      this.elements.saveCopy.hidden = false;
      this.setDocumentStatus(
        'Conflito: o arquivo mudou no disco. Reabra ou salve uma cópia.',
        'error',
      );
      return;
    }
    await this.write(this.handle, xml);
    this.markSaved(xml, this.handle, this.fileName ?? currentDisk.name);
  }

  private async saveCopy(): Promise<void> {
    if (!this.hasDiagram) return;
    const xml = await this.requireEditor().getXml();
    const browser = window as PickerWindow;
    if (!browser.showSaveFilePicker) {
      this.download(xml, this.copyName());
      this.markSaved(xml, undefined, this.copyName());
      return;
    }
    const copy = await browser.showSaveFilePicker({
      suggestedName: this.copyName(),
      types: [{ description: 'BPMN XML', accept: { 'application/xml': ['.bpmn'] } }],
    });
    await this.write(copy, xml);
    const file = await copy.getFile();
    this.markSaved(xml, copy, file.name);
  }

  private async write(handle: LocalFileHandle, xml: string): Promise<void> {
    const writable = await handle.createWritable();
    await writable.write(xml);
    await writable.close();
  }

  private download(xml: string, name = this.fileName ?? 'process.bpmn'): void {
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private copyName(): string {
    const base = this.fileName?.replace(/\.(bpmn|xml)$/i, '') ?? 'process';
    return `${base}-copy.bpmn`;
  }

  private markSaved(xml: string, handle: LocalFileHandle | undefined, name: string): void {
    this.handle = handle;
    this.fileName = name;
    this.diskBaseline = xml;
    this.dirty = false;
    this.elements.fileName.textContent = name;
    this.elements.saveCopy.hidden = true;
    this.setDocumentStatus(
      handle ? 'Salvo no arquivo do projeto' : 'Cópia baixada · arquivo original sem acesso direto',
      'saved',
    );
    this.updateControls();
  }

  private setDocumentStatus(message: string, state: 'dirty' | 'error' | 'saved'): void {
    this.elements.status.textContent = message;
    this.elements.status.className = `studio-status ${state}`;
  }

  private updateControls(): void {
    const hasEditor = Boolean(this.editor);
    this.elements.create.disabled = !hasEditor || this.busy;
    this.elements.open.disabled = !hasEditor || this.busy;
    this.elements.openEmpty.disabled = !hasEditor || this.busy;
    this.elements.validate.disabled = !this.hasDiagram || this.busy;
    this.elements.save.disabled = !this.hasDiagram || this.busy;
    this.elements.saveCopy.disabled = !this.hasDiagram || this.busy;
  }

  private requireEditor(): Editor {
    if (!this.editor) throw new Error('O editor BPMN ainda não foi inicializado.');
    return this.editor;
  }

  private isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
  }
}
