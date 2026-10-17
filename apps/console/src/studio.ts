import type {
  BpmnModel,
  FlowNode,
  ProcessModel,
  StaticAnalysisIssue,
  UnsupportedElement,
  ValidationIssue,
} from '@bpmn-flow/core';
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
  validationTab: HTMLButtonElement;
  architectureTab: HTMLButtonElement;
  validationPanel: HTMLElement;
  architecturePanel: HTMLElement;
  architectureSummary: HTMLElement;
  processes: HTMLElement;
  risks: HTMLElement;
  unsupported: HTMLElement;
  exportReview: HTMLButtonElement;
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
  private reviewModel?: BpmnModel;
  private structuralRisks: StaticAnalysisIssue[] = [];

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
    elements.validationTab.addEventListener('click', () => this.selectReviewTab('validation'));
    elements.architectureTab.addEventListener('click', () => this.selectReviewTab('architecture'));
    elements.exportReview.addEventListener('click', () => this.exportReview());
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
      this.resetReview();
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
    this.initialization = undefined;
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
    this.resetReview();
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
    this.resetReview();
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
    this.elements.saveCopy.hidden = true;
    this.resetReview();
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
    const { analyzeProcess } = await import('@bpmn-flow/core');
    this.reviewModel = result.model;
    this.structuralRisks =
      result.model?.processes.flatMap((process) => analyzeProcess(process)) ?? [];
    this.renderArchitecture(result.model);
    const errors = result.issues.filter((issue) => issue.severity === 'error').length;
    const warnings = result.issues.length - errors;
    const summary = `${errors} erro(s) · ${warnings} aviso(s)`;
    const savedState = this.dirty ? 'dirty' : 'saved';
    this.setDocumentStatus(
      `${result.valid ? 'Validação concluída' : 'Validação falhou'} · ${summary}${this.dirty ? ' · alterações não salvas' : ''}`,
      result.valid ? savedState : 'error',
    );
  }

  private selectReviewTab(tab: 'validation' | 'architecture'): void {
    if (tab === 'architecture' && this.elements.architectureTab.disabled) return;
    const isValidation = tab === 'validation';
    this.elements.validationTab.classList.toggle('active', isValidation);
    this.elements.validationTab.setAttribute('aria-selected', String(isValidation));
    this.elements.architectureTab.classList.toggle('active', !isValidation);
    this.elements.architectureTab.setAttribute('aria-selected', String(!isValidation));
    this.elements.validationPanel.hidden = !isValidation;
    this.elements.architecturePanel.hidden = isValidation;
  }

  private resetReview(): void {
    this.reviewModel = undefined;
    this.structuralRisks = [];
    this.elements.issues.replaceChildren();
    this.elements.issueCount.textContent = '—';
    this.elements.architectureSummary.replaceChildren();
    this.elements.processes.replaceChildren();
    this.elements.risks.replaceChildren();
    this.elements.unsupported.replaceChildren();
    this.elements.architectureTab.disabled = true;
    this.elements.exportReview.disabled = true;
    this.selectReviewTab('validation');
  }

  private renderArchitecture(model: BpmnModel | undefined): void {
    this.elements.architectureSummary.replaceChildren();
    this.elements.processes.replaceChildren();
    this.elements.risks.replaceChildren();
    this.elements.unsupported.replaceChildren();
    this.elements.architectureTab.disabled = false;
    this.elements.exportReview.disabled = !model;
    if (!model) {
      this.elements.architectureSummary.append(
        this.messageBox(
          'Análise parcial indisponível',
          'O parser não conseguiu formar um modelo. Corrija os erros de validação para revisar a estrutura.',
        ),
      );
      this.elements.risks.append(
        this.messageBox('Sem análise estrutural', 'Nenhum risco foi calculado.'),
      );
      this.elements.processes.append(
        this.messageBox(
          'Nenhum processo identificado',
          'Corrija os erros do parser para preencher o inventário.',
        ),
      );
      this.elements.unsupported.append(
        this.messageBox('Sem inventário', 'O XML precisa ser interpretado antes desta lista.'),
      );
      return;
    }

    const overview = model.processes.map((process) => this.processOverview(process));
    const nodes = model.processes.flatMap((process) => this.nodesIn(process));
    const scopes = model.processes.flatMap((process) => this.scopesIn(process));
    const activities = nodes.filter((node) => this.isActivity(node));
    const gateways = nodes.filter((node) => node.kind.endsWith('Gateway'));
    const events = nodes.filter((node) => node.kind.endsWith('Event'));
    const flows = scopes.reduce((count, scope) => count + scope.sequenceFlows.length, 0);
    const dataElements =
      scopes.reduce((count, scope) => count + (scope.dataElements?.length ?? 0), 0) +
      model.dataStores.length;
    const summary: [string, number][] = [
      ['Processos', model.processes.length],
      ['Atividades', activities.length],
      ['Gateways', gateways.length],
      ['Eventos', events.length],
      ['Fluxos', flows],
      ['Dados', dataElements],
      ['Mensagens', model.messageFlows.length],
      ['Fora do runtime', model.unsupported.length],
    ];
    const metrics = document.createElement('div');
    metrics.className = 'studio-architecture-metrics';
    for (const [label, count] of summary) {
      const card = document.createElement('div');
      card.className = 'studio-architecture-metric';
      const value = document.createElement('strong');
      value.textContent = String(count);
      const caption = document.createElement('span');
      caption.textContent = label;
      card.append(value, caption);
      metrics.append(card);
    }
    this.elements.architectureSummary.append(metrics);

    for (const { process, nodes: processNodes, scopes: processScopes } of overview) {
      this.elements.processes.append(this.processCard(process, processNodes, processScopes));
    }
    if (overview.length === 0) {
      this.elements.processes.append(
        this.messageBox(
          'Nenhum processo identificado',
          'O BPMN não declara processos para revisar.',
        ),
      );
    }
    if (this.structuralRisks.length === 0) {
      this.elements.risks.append(
        this.messageBox(
          'Nenhum risco estático encontrado',
          'A análise estrutural não encontrou becos sem saída ou gateways sem rota padrão.',
        ),
      );
    } else {
      for (const issue of this.structuralRisks) this.elements.risks.append(this.findingItem(issue));
    }
    if (model.unsupported.length === 0) {
      this.elements.unsupported.append(
        this.messageBox(
          'Modelo compatível',
          'O parser não encontrou construções BPMN fora do escopo do runtime.',
        ),
      );
    } else {
      for (const issue of model.unsupported) {
        this.elements.unsupported.append(this.unsupportedItem(issue));
      }
    }
  }

  private processOverview(process: ProcessModel): {
    process: ProcessModel;
    nodes: FlowNode[];
    scopes: ProcessModel[];
  } {
    const scopes = this.scopesIn(process);
    return { process, scopes, nodes: scopes.flatMap((scope) => scope.flowNodes) };
  }

  private scopesIn(process: ProcessModel): ProcessModel[] {
    return [
      process,
      ...process.flowNodes.flatMap((node) => (node.process ? this.scopesIn(node.process) : [])),
    ];
  }

  private nodesIn(process: ProcessModel): FlowNode[] {
    return this.scopesIn(process).flatMap((scope) => scope.flowNodes);
  }

  private isActivity(node: FlowNode): boolean {
    return (
      node.kind === 'task' ||
      node.kind.endsWith('Task') ||
      ['subProcess', 'transaction', 'adHocSubProcess', 'callActivity'].includes(node.kind)
    );
  }

  private processCard(
    process: ProcessModel,
    nodes: FlowNode[],
    scopes: ProcessModel[],
  ): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'studio-process-card';
    const title = document.createElement('div');
    title.className = 'studio-process-title';
    const name = document.createElement('strong');
    name.textContent = process.name ?? process.id;
    const executable = document.createElement('span');
    executable.className = `studio-process-kind ${process.isExecutable ? 'executable' : ''}`;
    executable.textContent = process.isExecutable ? 'executável' : 'não executável';
    title.append(name, executable);
    item.append(title);
    if (process.name && process.name !== process.id) item.append(this.nodeReference(process.id));

    const lanes = [...new Set(nodes.flatMap((node) => (node.lane ? [node.lane] : [])))].sort();
    const candidates = [...new Set(nodes.flatMap((node) => node.candidates ?? []))].sort();
    const jobs = [...new Set(nodes.flatMap((node) => (node.job ? [node.job.type] : [])))].sort();
    const calls = nodes.filter((node) => node.kind === 'callActivity' && node.calledElement);
    const dataCount = scopes.reduce((count, scope) => count + (scope.dataElements?.length ?? 0), 0);
    const details = document.createElement('p');
    details.className = 'studio-process-details';
    details.textContent = `${nodes.filter((node) => this.isActivity(node)).length} atividades · ${nodes.filter((node) => node.kind.endsWith('Gateway')).length} gateways · ${scopes.reduce((count, scope) => count + scope.sequenceFlows.length, 0)} fluxos · ${dataCount} dados`;
    item.append(details);
    this.appendMetadata(item, 'Raias', lanes);
    this.appendMetadata(item, 'Candidatos', candidates);
    this.appendMetadata(item, 'Tipos de job', jobs);
    for (const call of calls) {
      item.append(this.focusButton(`${call.name ?? call.id} → ${call.calledElement}`, call.id));
    }
    return item;
  }

  private appendMetadata(parent: HTMLElement, label: string, values: string[]): void {
    if (values.length === 0) return;
    const row = document.createElement('p');
    row.className = 'studio-process-metadata';
    const title = document.createElement('strong');
    title.textContent = `${label}: `;
    row.append(title, document.createTextNode(values.join(', ')));
    parent.append(row);
  }

  private findingItem(issue: StaticAnalysisIssue): HTMLLIElement {
    const item = document.createElement('li');
    item.className = `studio-issue ${issue.severity}`;
    const message = document.createElement('span');
    message.textContent = issue.message;
    item.append(message, this.focusButton(`Abrir ${issue.nodeId}`, issue.nodeId));
    if (issue.causeNodeId) {
      item.append(this.focusButton(`Abrir causa ${issue.causeNodeId}`, issue.causeNodeId));
    }
    return item;
  }

  private unsupportedItem(issue: UnsupportedElement): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'studio-issue warning';
    const message = document.createElement('span');
    message.textContent = `<${issue.type}>${issue.ownerId ? ` em ${issue.ownerId}` : ''} não é modelado pelo runtime.`;
    item.append(message);
    const elementId = issue.ownerId ?? issue.id;
    if (elementId) item.append(this.focusButton(`Abrir ${elementId}`, elementId));
    return item;
  }

  private focusButton(label: string, nodeId: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'studio-focus-link';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (!this.requireEditor().focusElement(nodeId)) {
        this.onError(new Error(`O elemento ${nodeId} não está no diagrama aberto.`));
      }
    });
    return button;
  }

  private messageBox(title: string, message: string): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'studio-review-empty';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('span');
    detail.textContent = message;
    item.append(heading, detail);
    return item;
  }

  private exportReview(): void {
    if (!this.reviewModel) return;
    const report = this.reviewReport(this.reviewModel);
    const baseName = (this.fileName ?? 'process').replace(/\.(bpmn|xml)$/i, '');
    this.downloadText(`${baseName}-architecture-review.md`, report);
  }

  private reviewReport(model: BpmnModel): string {
    const lines = [
      `# Revisão de arquitetura BPMN: ${this.reportText(model.name ?? model.id)}`,
      '',
      `Gerado a partir de ${this.reportText(this.fileName ?? 'BPMN não salvo')}.`,
      '',
      '## Inventário',
      '',
      `- Processos: ${model.processes.length}`,
      `- Participantes: ${model.participants.length}`,
      `- Fluxos de mensagem: ${model.messageFlows.length}`,
      `- Riscos estruturais: ${this.structuralRisks.length}`,
      `- Construções fora do runtime: ${model.unsupported.length}`,
    ];
    for (const process of model.processes) {
      const { nodes, scopes } = this.processOverview(process);
      const lanes = [...new Set(nodes.flatMap((node) => (node.lane ? [node.lane] : [])))].sort();
      const candidates = [...new Set(nodes.flatMap((node) => node.candidates ?? []))].sort();
      const jobs = [...new Set(nodes.flatMap((node) => (node.job ? [node.job.type] : [])))].sort();
      lines.push(
        '',
        `## ${this.reportText(process.name ?? process.id)} (${this.reportText(process.id)})`,
        '',
        `- Executável: ${process.isExecutable ? 'sim' : 'não'}`,
        `- Atividades: ${nodes.filter((node) => this.isActivity(node)).length}`,
        `- Gateways: ${nodes.filter((node) => node.kind.endsWith('Gateway')).length}`,
        `- Eventos: ${nodes.filter((node) => node.kind.endsWith('Event')).length}`,
        `- Fluxos de sequência: ${scopes.reduce((count, scope) => count + scope.sequenceFlows.length, 0)}`,
        `- Elementos de dados: ${scopes.reduce((count, scope) => count + (scope.dataElements?.length ?? 0), 0)}`,
        `- Raias: ${this.reportText(lanes.join(', ') || 'nenhuma declarada')}`,
        `- Candidatos: ${this.reportText(candidates.join(', ') || 'nenhum declarado')}`,
        `- Tipos de job: ${this.reportText(jobs.join(', ') || 'nenhum declarado')}`,
      );
    }
    lines.push('', '## Riscos estruturais', '');
    if (this.structuralRisks.length === 0)
      lines.push('Nenhum risco estrutural estático encontrado.');
    for (const issue of this.structuralRisks) {
      lines.push(
        `- **${issue.severity === 'error' ? 'erro' : 'aviso'}** [${this.reportText(issue.nodeId)}] ${this.reportText(issue.message)}`,
      );
    }
    lines.push('', '## Construções fora do runtime', '');
    if (model.unsupported.length === 0)
      lines.push('Nenhuma construção fora do runtime encontrada.');
    for (const issue of model.unsupported) {
      lines.push(
        `- &lt;${this.reportText(issue.type)}&gt;${issue.ownerId ? ` em [${this.reportText(issue.ownerId)}]` : ''}`,
      );
    }
    lines.push(
      '',
      'Responsabilidades refletem raias e candidatos declarados no BPMN; o ownership do código-fonte ainda não foi mapeado.',
      '',
    );
    return lines.join('\n');
  }

  private reportText(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('`', '\\`')
      .replaceAll('*', '\\*')
      .replaceAll('_', '\\_')
      .replaceAll('[', '\\[')
      .replaceAll(']', '\\]')
      .replace(/[\r\n]/g, ' ');
  }

  private downloadText(name: string, content: string): void {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name.replace(/[\\/:*?"<>|]/g, '-');
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
