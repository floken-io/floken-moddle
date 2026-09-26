// 生成一份样例 BPMN 2.0 文件，用于人工核对 M2 的导出形态。
// 用法：node examples/gen-sample.mjs   （依赖已构建的 dist/）
import { writeFileSync } from 'node:fs';

import { fromXmlSync, toXmlSync } from '../dist/index.js';

const def = {
  schemaVersion: '1.0.0',
  id: 'Definitions_1',
  name: '报销流程',
  version: 3,
  processes: [
    {
      id: 'Process_1',
      name: '主流程',
      executable: true,
      nodes: [
        { id: 'StartEvent_1', type: 'startEvent', name: '发起' },
        {
          id: 'UserTask_1',
          type: 'userTask',
          name: '部门经理审批',
          formKey: 'expense-form',
          extension: {
            'floken:approval': {
              approvers: [
                { type: 'user', value: 'u1' },
                { type: 'deptLeader', of: 'starter' },
              ],
              approverPolicy: 'all',
              mode: 'vote',
              vote: { threshold: 0.5 },
              onReject: 'abort',
              reject: { allowed: true, requireComment: true },
              timeout: { duration: 'P3D', actions: [{ type: 'remind', interval: 'PT4H' }] },
              cc: { to: [{ type: 'role', value: 'finance' }], on: ['completed'] },
            },
            'camunda:assignee': 'demo',
          },
        },
        { id: 'Gateway_1', type: 'exclusiveGateway', name: '金额判断' },
        {
          id: 'SubProcess_1',
          type: 'subProcess',
          name: '复核',
          nodes: [
            { id: 'Inner_Start', type: 'startEvent' },
            { id: 'Inner_Task', type: 'userTask', name: '复核' },
          ],
          flows: [{ id: 'Inner_Flow', from: 'Inner_Start', to: 'Inner_Task' }],
        },
        { id: 'EndEvent_1', type: 'endEvent' },
        {
          id: 'Boundary_1',
          type: 'boundaryEvent',
          attachedTo: 'UserTask_1',
          eventDefinition: {
            type: 'timer',
            timeDuration: {
              body: 'PT2H',
              language: 'https://www.omg.org/spec/DMN/20230324/FEEL/',
            },
          },
        },
      ],
      flows: [
        { id: 'Flow_1', from: 'StartEvent_1', to: 'UserTask_1' },
        {
          id: 'Flow_2',
          from: 'UserTask_1',
          to: 'Gateway_1',
          condition: { body: 'amount > 5000', language: 'https://www.omg.org/spec/DMN/20230324/FEEL/' },
        },
        { id: 'Flow_3', from: 'Gateway_1', to: 'SubProcess_1', name: '大于五千' },
        { id: 'Flow_4', from: 'SubProcess_1', to: 'EndEvent_1' },
      ],
    },
  ],
  meta: { owner: 'finance-team' },
};

const xml = toXmlSync(def);
writeFileSync(new URL('./expense.bpmn', import.meta.url), xml, 'utf8');
const back = fromXmlSync(xml);
const again = toXmlSync(back);
console.log('written examples/expense.bpmn');
console.log('idempotent:', again === xml);
