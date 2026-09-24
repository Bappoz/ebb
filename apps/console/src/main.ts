import type { BpmnFlowViewer } from '@bpmn-flow/viewer';
import type { ReplayView } from '@ebb/runtime';
import { fetchInstances, fetchReplay, forkAt } from './api.js';
import { clampStep, frameAt, listRows, parseRoute, routeTo, type Frame } from './timeline.js';
import './style.css';

/*
 * Fiação de navegador. A lógica (rotas, passo válido, o que pintar) está em
 * timeline.ts; aqui só DOM e eventos. Todo texto de instância entra por
 * `textContent`: variável de processo é dado de usuário, nunca HTML.
 */

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento #${id} ausente do index.html.`);
  return element;
}

function inputById(id: string): HTMLInputElement {
  const element = byId(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} deveria ser um <input>.`);
  return element;
}

function buttonById(id: string): HTMLButtonElement {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} deveria ser um <button>.`);
  return element;
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

const listView = byId('list-view');
const debuggerView = byId('debugger-view');
const errorBox = byId('error');
const crumb = byId('crumb');
const slider = inputById('step');
const prev = buttonById('prev');
const next = buttonById('next');
const forkButton = buttonById('fork');

let viewer: BpmnFlowViewer | undefined;
/** O replay aberto, reaproveitado enquanto só o passo muda. */
let current: ReplayView | undefined;
/** O passo pintado agora. */
let shown = 0;
/**
 * Contador de navegação: cada `render` pega um número, e uma carga que
 * termina depois de outra navegação começar é descartada — senão um clique
 * rápido pintaria o replay velho por cima do novo.
 */
let navigation = 0;

async function ensureViewer(): Promise<BpmnFlowViewer> {
  if (viewer) return viewer;
  const { BpmnFlowViewer } = await import('./diagram-view.js');
  viewer = new BpmnFlowViewer({ container: byId('diagram') });
  return viewer;
}

function showError(error: unknown): void {
  const back = el('a', 'voltar à lista');
  back.setAttribute('href', '#/');
  errorBox.replaceChildren(
    el('span', error instanceof Error ? error.message : String(error)),
    document.createTextNode(' — '),
    back,
  );
  errorBox.hidden = false;
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

async function showList(ticket: number): Promise<void> {
  const instances = await fetchInstances();
  if (ticket !== navigation) return;
  const tbody = byId('instances');
  tbody.replaceChildren();
  for (const row of listRows(instances)) {
    const tr = el('tr');
    tr.append(
      el('td', row.short),
      el('td', row.process),
      el('td', row.version),
      el('td', row.status),
      el('td', row.commands),
      el('td', row.origin),
    );
    tr.addEventListener('click', () => {
      location.hash = routeTo({ view: 'instance', id: row.id });
    });
    tbody.append(tr);
  }
  byId('empty').hidden = instances.length > 0;
  crumb.textContent = '';
  debuggerView.hidden = true;
  listView.hidden = false;
}

function paint(target: BpmnFlowViewer, frame: Frame): void {
  // Sempre do zero: `applySnapshot` preserva fluxos já marcados, então voltar
  // um passo só despinta se a marcação recomeçar.
  target.clear();
  for (const flow of frame.flows) target.markFlowTaken(flow);
  target.applySnapshot(frame.snapshot);

  byId('step-title').textContent = frame.title;
  byId('status').textContent = `estado: ${frame.status}`;
  byId('payload').textContent = frame.payload;

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
    const view = await fetchReplay(id);
    const target = await ensureViewer();
    if (ticket !== navigation) return;
    // O diagrama precisa estar visível para o viewer medir o container.
    listView.hidden = true;
    debuggerView.hidden = false;
    await target.load(view.xml);
    if (ticket !== navigation) return;
    current = view;
  }
  const view = current;
  const target = await ensureViewer();
  if (ticket !== navigation || !view) return;

  const n = clampStep(step, view.steps.length);
  if (n !== step) history.replaceState(null, '', routeTo({ view: 'instance', id, step: n }));
  crumb.textContent = `${view.instance.processKey} v${view.instance.version} · ${view.instance.id}`;
  listView.hidden = true;
  debuggerView.hidden = false;
  paint(target, frameAt(view, n));
}

async function render(): Promise<void> {
  const ticket = ++navigation;
  errorBox.hidden = true;
  const route = parseRoute(location.hash);
  try {
    if (route.view === 'list') {
      current = undefined;
      await showList(ticket);
    } else {
      await showInstance(route.id, route.step, ticket);
    }
  } catch (error) {
    if (ticket !== navigation) return;
    // Nada da tela anterior fica por baixo do erro, nem o cabeçalho: ele
    // apontaria para uma instância que não é a da URL.
    crumb.textContent = '';
    listView.hidden = true;
    debuggerView.hidden = true;
    showError(error);
  }
}

function go(step: number): void {
  if (!current) return;
  location.hash = routeTo({ view: 'instance', id: current.instance.id, step });
}

slider.addEventListener('input', () => go(Number(slider.value)));
prev.addEventListener('click', () => go(shown - 1));
next.addEventListener('click', () => go(shown + 1));
window.addEventListener('keydown', (event) => {
  // O próprio slider já anda com as setas quando tem foco; tratar de novo
  // aqui pularia dois passos.
  if (debuggerView.hidden || event.target === slider) return;
  if (event.key === 'ArrowLeft' && shown > 1) go(shown - 1);
  if (event.key === 'ArrowRight' && current && shown < current.steps.length) go(shown + 1);
});
forkButton.addEventListener('click', () => {
  if (!current) return;
  forkButton.disabled = true;
  forkAt(current.instance.id, shown)
    .then((forked) => {
      location.hash = routeTo({ view: 'instance', id: forked.id });
    })
    .catch(showError)
    .finally(() => {
      forkButton.disabled = false;
    });
});
window.addEventListener('hashchange', () => void render());
void render();
