/**
 * Ponto de entrada do pedaço pesado do bundle: `bpmn-visualization` (e o
 * `mxgraph` por baixo) é quase todo o console. Importado dinamicamente, vira
 * um chunk baixado só quando a primeira instância abre.
 */
import '@bpmn-flow/viewer/styles.css';

export { BpmnFlowViewer } from '@bpmn-flow/viewer';
