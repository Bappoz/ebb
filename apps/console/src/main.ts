import type { BpmnFlowViewer } from '@bpmn-flow/viewer';
import type { HumanTaskRecord, IncidentRecord } from '@ebb/api';
import type { ReplayView } from '@ebb/runtime';
import type { ProcessSummary } from '@ebb/store';
import {
  completeHumanTask,
  fetchIncidents,
  fetchInstances,
  fetchProcesses,
  fetchReplay,
  fetchTasks,
  forkAt,
  resolveIncident,
  retryIncident,
  startInstance,
} from './api.js';
import { lazy, serial } from './loading.js';
import {
  clampStep,
  frameAt,
  listRows,
  parseRoute,
  routeTo,
  type Frame,
  type Route,
} from './timeline.js';
import './style.css';

/*
 * Fiação do console. Dados do processo entram no DOM só por `textContent` ou
 * `value`; nenhuma variável vira HTML executável.
 */

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento #${id} ausente do index.html.`);
  return element;
}

function asElement<T extends HTMLElement>(id: string, type: new (...args: never[]) => T): T {
  const element = byId(id);
  if (!(element instanceof type)) throw new Error(`#${id} tem o tipo de elemento errado.`);
  return element;
}

function buttonById(id: string): HTMLButtonElement {
  return asElement(id, HTMLButtonElement);
}

function inputById(id: string): HTMLInputElement {
  return asElement(id, HTMLInputElement);
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function text(id: string, value: string | number): void {
  byId(id).textContent = String(value);
}

const dashboardView = byId('dashboard-view');
const tasksView = byId('tasks-view');
const incidentsView = byId('incidents-view');
const debuggerView = byId('debugger-view');
const views = [dashboardView, tasksView, incidentsView, debuggerView];
const errorBox = byId('error');
const successBox = byId('success');
const crumb = byId('crumb');
const eyebrow = byId('eyebrow');
const slider = inputById('step');
const prev = buttonById('prev');
const next = buttonById('next');
const forkButton = buttonById('fork');
const startDialog = asElement('start-dialog', HTMLDialogElement);
const startForm = asElement('start-form', HTMLFormElement);
const processSelect = asElement('start-process', HTMLSelectElement);
const startVariables = asElement('start-variables', HTMLTextAreaElement);
const startRetries = inputById('start-retries');
const submitStart = buttonById('submit-start');

const viewer = lazy(async (): Promise<BpmnFlowViewer> => {
  const { BpmnFlowViewer } = await import('./diagram-view.js');
  return new BpmnFlowViewer({ container: byId('diagram') });
});
const loads = serial();
let current: ReplayView | undefined;
let shown = 0;
let navigation = 0;
let published: ProcessSummary[] = [];

function showError(error: unknown): void {
  errorBox.textContent = error instanceof Error ? error.message : String(error);
  errorBox.hidden = false;
  successBox.hidden = true;
}

function showSuccess(message: string): void {
  successBox.textContent = message;
  successBox.hidden = false;
  errorBox.hidden = true;
  window.setTimeout(() => {
    successBox.hidden = true;
  }, 3_500);
}

function setHeader(section: string, title: string): void {
  eyebrow.textContent = section;
  crumb.textContent = title;
}

function showView(target: HTMLElement, nav?: 'dashboard' | 'tasks' | 'incidents'): void {
  for (const view of views) view.hidden = view !== target;
  for (const link of document.querySelectorAll<HTMLElement>('[data-nav]')) {
    link.classList.toggle('active', link.dataset.nav === nav);
  }
}

function badge(id: string, count: number): void {
  const target = byId(id);
  target.textContent = String(count);
  target.hidden = count === 0;
}

function statusPill(status: string): HTMLElement {
  const labels: Record<string, string> = {
    completed: 'concluída',
    failed: 'falhou',
    running: 'em andamento',
    terminated: 'encerrada',
    waiting: 'aguardando',
  };
  return el('span', labels[status] ?? status, `status-pill ${status}`);
}

function processName(processKey: string): string {
  return published.find((process) => process.processKey === processKey)?.name ?? processKey;
}

function td(content: string | HTMLElement, className?: string): HTMLElement {
  const cell = el('td', undefined, className);
  cell.append(content);
  return cell;
}

function kvTable(rows: [string, string][]): HTMLElement {
  const table = el('table', undefined, 'kv');
  for (const [key, value] of rows) {
    const tr = el('tr');
    tr.append(el('td', key), el('td', value));
    table.append(tr);
  }
  return table;
}

function section(id: string, title: string, content: HTMLElement[]): void {
  const target = byId(id);
  target.replaceChildren();
  if (content.length === 0) return;
  target.append(el('h3', title), ...content);
}

function emptyDetail(title: string, description: string): HTMLElement {
  const box = el('div', undefined, 'empty-detail');
  box.append(el('span', '◇', 'empty-icon'), el('h3', title), el('p', description));
  return box;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function navigate(route: Route): void {
  const hash = routeTo(route);
  if (location.hash === hash) void render();
  else location.hash = hash;
}

async function showDashboard(ticket: number): Promise<void> {
  const [instances, tasks, incidents, processes] = await Promise.all([
    fetchInstances(),
    fetchTasks(),
    fetchIncidents(),
    fetchProcesses(),
  ]);
  if (ticket !== navigation) return;
  published = processes;
  text(
    'metric-running',
    instances.filter((instance) => !['completed', 'failed', 'terminated'].includes(instance.status))
      .length,
  );
  text('metric-tasks', tasks.length);
  text('metric-incidents', incidents.length);
  text('metric-processes', processes.length);
  text(
    'updated-at',
    `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
  );
  badge('task-badge', tasks.length);
  badge('incident-badge', incidents.length);

  const tbody = byId('instances');
  tbody.replaceChildren();
  for (const row of listRows(instances)) {
    const tr = el('tr');
    tr.append(
      td(processName(row.process)),
      td(row.short, 'mono'),
      td(statusPill(row.status)),
      td(row.version),
      td(row.commands),
      td(row.origin || '—', row.origin ? 'mono' : undefined),
    );
    tr.addEventListener('click', () => navigate({ view: 'instance', id: row.id }));
    tbody.append(tr);
  }
  byId('empty').hidden = instances.length > 0;
  setHeader('Operação', 'Visão geral');
  showView(dashboardView, 'dashboard');
}

function itemCard(
  title: string,
  process: string,
  instanceId: string,
  selected: boolean,
  danger = false,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `item-card${selected ? ' selected' : ''}${danger ? ' danger' : ''}`;
  button.append(
    el('span', title, 'item-title'),
    (() => {
      const meta = el('span', undefined, 'item-meta');
      meta.append(el('span', process), el('span', short(instanceId), 'mono'));
      return meta;
    })(),
  );
  return button;
}

interface VariableEditor {
  form: HTMLFormElement;
  read: () => Record<string, unknown>;
  submit: HTMLButtonElement;
}

function jsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} precisa ser JSON válido.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} precisa ser um objeto JSON.`);
  }
  return value as Record<string, unknown>;
}

function variableEditor(variables: Record<string, unknown>, submitLabel: string): VariableEditor {
  const form = document.createElement('form');
  form.className = 'variable-form';
  form.append(el('p', 'Variáveis da tarefa', 'form-section-title'));
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();

  for (const [key, value] of Object.entries(variables)) {
    const label = el('label', undefined, 'field');
    label.append(el('span', key));
    let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (typeof value === 'boolean') {
      const select = document.createElement('select');
      for (const optionValue of ['true', 'false']) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue === 'true' ? 'Sim' : 'Não';
        option.selected = String(value) === optionValue;
        select.append(option);
      }
      select.dataset.kind = 'boolean';
      control = select;
    } else if (typeof value === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(value);
      input.dataset.kind = 'number';
      control = input;
    } else if (typeof value === 'string') {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.dataset.kind = 'string';
      control = input;
    } else {
      const textarea = document.createElement('textarea');
      textarea.rows = 4;
      textarea.value = JSON.stringify(value, null, 2);
      textarea.dataset.kind = 'json';
      control = textarea;
    }
    controls.set(key, control);
    label.append(control);
    form.append(label);
  }

  if (controls.size === 0) {
    form.append(
      el(
        'p',
        'Esta tarefa não recebeu variáveis. Você ainda pode enviar uma saída abaixo.',
        'collection-help',
      ),
    );
  }
  const extraLabel = el('label', undefined, 'field');
  const extraTitle = el('span', 'Saída adicional');
  extraTitle.append(el('small', ' JSON'));
  const extra = document.createElement('textarea');
  extra.rows = 4;
  extra.value = '{}';
  extra.spellcheck = false;
  extraLabel.append(extraTitle, extra);
  form.append(extraLabel);

  const actions = el('div', undefined, 'form-actions');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'button primary';
  submit.textContent = submitLabel;
  actions.append(submit);
  form.append(actions);

  const read = (): Record<string, unknown> => {
    const output: Record<string, unknown> = {};
    for (const [key, control] of controls) {
      switch (control.dataset.kind) {
        case 'boolean':
          output[key] = control.value === 'true';
          break;
        case 'number':
          if (control.value === '' || !Number.isFinite(Number(control.value))) {
            throw new Error(`"${key}" precisa ser um número.`);
          }
          output[key] = Number(control.value);
          break;
        case 'json':
          try {
            output[key] = JSON.parse(control.value) as unknown;
          } catch {
            throw new Error(`"${key}" precisa ser JSON válido.`);
          }
          break;
        default:
          output[key] = control.value;
      }
    }
    return { ...output, ...jsonObject(extra.value, 'Saída adicional') };
  };
  return { form, read, submit };
}

function taskDetail(task: HumanTaskRecord): HTMLElement {
  const content = el('div', undefined, 'detail-content');
  content.append(
    el('p', 'Tarefa humana', 'eyebrow'),
    el('h2', task.name ?? task.nodeId),
    el(
      'p',
      `${task.processKey} v${task.version} · instância ${short(task.instanceId)}`,
      'detail-subtitle',
    ),
  );
  const chips = el('div', undefined, 'chips');
  if (task.lane) chips.append(el('span', `Raia: ${task.lane}`, 'chip'));
  for (const candidate of task.candidates) chips.append(el('span', candidate, 'chip'));
  if (chips.childElementCount > 0) content.append(chips);
  const editor = variableEditor(task.variables, 'Concluir tarefa');
  editor.form.addEventListener('submit', (event) => {
    event.preventDefault();
    editor.submit.disabled = true;
    try {
      const output = editor.read();
      completeHumanTask(task.instanceId, task.tokenId, output)
        .then(() => {
          showSuccess('Tarefa concluída e processo continuado.');
          navigate({ view: 'tasks' });
        })
        .catch(showError)
        .finally(() => {
          editor.submit.disabled = false;
        });
    } catch (error) {
      editor.submit.disabled = false;
      showError(error);
    }
  });
  content.append(editor.form);
  return content;
}

async function showTasks(route: Extract<Route, { view: 'tasks' }>, ticket: number): Promise<void> {
  const [tasks, incidents] = await Promise.all([fetchTasks(), fetchIncidents()]);
  if (ticket !== navigation) return;
  badge('task-badge', tasks.length);
  badge('incident-badge', incidents.length);
  text('task-count', tasks.length);
  const selected =
    tasks.find((task) => task.instanceId === route.instanceId && task.tokenId === route.tokenId) ??
    tasks[0];
  const list = byId('task-list');
  list.replaceChildren();
  for (const task of tasks) {
    const button = itemCard(
      task.name ?? task.nodeId,
      task.processKey,
      task.instanceId,
      task === selected,
    );
    button.addEventListener('click', () =>
      navigate({ view: 'tasks', instanceId: task.instanceId, tokenId: task.tokenId }),
    );
    list.append(button);
  }
  const detail = byId('task-detail');
  detail.replaceChildren(
    selected
      ? taskDetail(selected)
      : emptyDetail('Fila em dia', 'Não há tarefas humanas aguardando uma decisão.'),
  );
  setHeader('Trabalho', 'Minha fila');
  showView(tasksView, 'tasks');
}

function incidentDetail(incident: IncidentRecord): HTMLElement {
  const content = el('div', undefined, 'detail-content');
  content.append(
    el('p', 'Incidente aberto', 'eyebrow'),
    el('h2', incident.nodeId),
    el(
      'p',
      `${incident.processKey} v${incident.version} · instância ${short(incident.instanceId)}`,
      'detail-subtitle',
    ),
  );
  const chips = el('div', undefined, 'chips');
  chips.append(
    el('span', `${incident.attempts} tentativa${incident.attempts === 1 ? '' : 's'}`, 'chip'),
  );
  content.append(chips, el('div', incident.message, 'incident-message'));

  const editor = variableEditor(incident.variables, 'Resolver e continuar');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button secondary';
  retry.textContent = 'Tentar novamente';
  editor.form.querySelector('.form-actions')?.prepend(retry);
  retry.addEventListener('click', () => {
    retry.disabled = true;
    retryIncident(incident.instanceId, incident.tokenId)
      .then(() => {
        showSuccess('Incidente reenviado para execução.');
        navigate({ view: 'incidents' });
      })
      .catch(showError)
      .finally(() => {
        retry.disabled = false;
      });
  });
  editor.form.addEventListener('submit', (event) => {
    event.preventDefault();
    editor.submit.disabled = true;
    try {
      const output = editor.read();
      resolveIncident(incident.instanceId, incident.tokenId, output)
        .then(() => {
          showSuccess('Incidente resolvido e processo continuado.');
          navigate({ view: 'incidents' });
        })
        .catch(showError)
        .finally(() => {
          editor.submit.disabled = false;
        });
    } catch (error) {
      editor.submit.disabled = false;
      showError(error);
    }
  });
  content.append(editor.form);
  return content;
}

async function showIncidents(
  route: Extract<Route, { view: 'incidents' }>,
  ticket: number,
): Promise<void> {
  const [incidents, tasks] = await Promise.all([fetchIncidents(), fetchTasks()]);
  if (ticket !== navigation) return;
  badge('task-badge', tasks.length);
  badge('incident-badge', incidents.length);
  text('incident-count', incidents.length);
  const selected =
    incidents.find(
      (incident) => incident.instanceId === route.instanceId && incident.tokenId === route.tokenId,
    ) ?? incidents[0];
  const list = byId('incident-list');
  list.replaceChildren();
  for (const incident of incidents) {
    const button = itemCard(
      incident.nodeId,
      incident.processKey,
      incident.instanceId,
      incident === selected,
      true,
    );
    button.addEventListener('click', () =>
      navigate({
        view: 'incidents',
        instanceId: incident.instanceId,
        tokenId: incident.tokenId,
      }),
    );
    list.append(button);
  }
  const detail = byId('incident-detail');
  detail.replaceChildren(
    selected
      ? incidentDetail(selected)
      : emptyDetail('Nenhum incidente', 'As execuções estão seguindo sem falhas técnicas abertas.'),
  );
  setHeader('Operação', 'Incidentes');
  showView(incidentsView, 'incidents');
}

function paint(target: BpmnFlowViewer, frame: Frame): void {
  target.clear();
  for (const flow of frame.flows) target.markFlowTaken(flow);
  target.applySnapshot(frame.snapshot);

  text('step-title', frame.title);
  const status = byId('status');
  status.textContent = frame.status;
  status.className = `status-chip ${frame.status}`;
  text('payload', frame.payload);
  section(
    'gateways',
    'Gateways',
    frame.gateways.map((gateway) => {
      const box = el('div');
      const list = el('ul');
      for (const option of gateway.options) {
        list.append(
          el('li', `${option.label} → ${option.flowId}`, option.taken ? 'option taken' : 'option'),
        );
      }
      box.append(el('strong', gateway.name), list, kvTable(gateway.variables));
      return box;
    }),
  );
  section('entered', 'Entrou em', frame.entered.length ? [el('p', frame.entered.join(', '))] : []);
  section('variables', 'Variáveis', frame.variables.length ? [kvTable(frame.variables)] : []);
  section(
    'tasks',
    'Pendente',
    frame.tasks.length
      ? [
          kvTable(
            frame.tasks.map((task) => [
              task.tokenId,
              `${task.nodeId} ${task.name} (${task.reason})`,
            ]),
          ),
        ]
      : [],
  );

  slider.max = `${frame.total}`;
  slider.value = `${frame.step}`;
  slider.disabled = frame.total <= 1;
  prev.disabled = frame.step <= 1;
  next.disabled = frame.step >= frame.total;
  shown = frame.step;
}

async function showInstance(id: string, step: number | undefined, ticket: number): Promise<void> {
  if (current?.instance.id !== id) {
    current = undefined;
    const view = await fetchReplay(id);
    const target = await viewer();
    if (ticket !== navigation) return;
    showView(debuggerView);
    await loads(() => target.load(view.xml));
    if (ticket !== navigation) return;
    current = view;
  }
  const view = current;
  const target = await viewer();
  if (ticket !== navigation || !view) return;

  const n = clampStep(step, view.steps.length);
  if (n !== step) history.replaceState(null, '', routeTo({ view: 'instance', id, step: n }));
  setHeader('Time-travel', `${view.instance.processKey} · ${short(view.instance.id)}`);
  showView(debuggerView);
  paint(target, frameAt(view, n));
}

async function render(): Promise<void> {
  const ticket = ++navigation;
  errorBox.hidden = true;
  const route = parseRoute(location.hash);
  try {
    if (route.view !== 'instance') current = undefined;
    switch (route.view) {
      case 'dashboard':
        await showDashboard(ticket);
        break;
      case 'tasks':
        await showTasks(route, ticket);
        break;
      case 'incidents':
        await showIncidents(route, ticket);
        break;
      case 'instance':
        await showInstance(route.id, route.step, ticket);
        break;
    }
  } catch (error) {
    if (ticket === navigation) showError(error);
  }
}

function go(step: number): void {
  if (!current) return;
  navigate({ view: 'instance', id: current.instance.id, step });
}

async function openStart(): Promise<void> {
  try {
    published = published.length > 0 ? published : await fetchProcesses();
    processSelect.replaceChildren();
    for (const process of published) {
      const option = document.createElement('option');
      option.value = process.processKey;
      option.textContent = `${process.name ?? process.processKey} · v${process.latestVersion}`;
      processSelect.append(option);
    }
    if (published.length === 0)
      throw new Error('Publique um processo antes de iniciar uma instância.');
    startDialog.showModal();
  } catch (error) {
    showError(error);
  }
}

buttonById('open-start').addEventListener('click', () => void openStart());
buttonById('close-start').addEventListener('click', () => startDialog.close());
buttonById('cancel-start').addEventListener('click', () => startDialog.close());
startForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitStart.disabled = true;
  try {
    const variables = jsonObject(startVariables.value, 'Variáveis iniciais');
    const retries = Number(startRetries.value);
    if (!Number.isInteger(retries) || retries < 0)
      throw new Error('Retries precisa ser um inteiro não negativo.');
    startInstance(processSelect.value, variables, retries)
      .then((result) => {
        startDialog.close();
        startVariables.value = '{}';
        showSuccess('Instância iniciada.');
        navigate({ view: 'instance', id: result.instance.id });
      })
      .catch(showError)
      .finally(() => {
        submitStart.disabled = false;
      });
  } catch (error) {
    submitStart.disabled = false;
    showError(error);
  }
});

slider.addEventListener('input', () => go(Number(slider.value)));
prev.addEventListener('click', () => go(shown - 1));
next.addEventListener('click', () => go(shown + 1));
window.addEventListener('keydown', (event) => {
  if (debuggerView.hidden || event.target === slider) return;
  if (event.key === 'ArrowLeft' && shown > 1) go(shown - 1);
  if (event.key === 'ArrowRight' && current && shown < current.steps.length) go(shown + 1);
});
forkButton.addEventListener('click', () => {
  if (!current) return;
  forkButton.disabled = true;
  forkAt(current.instance.id, shown)
    .then((forked) => {
      showSuccess('Bifurcação criada.');
      navigate({ view: 'instance', id: forked.id });
    })
    .catch(showError)
    .finally(() => {
      forkButton.disabled = false;
    });
});
window.addEventListener('hashchange', () => void render());
void render();
