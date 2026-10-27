// Starter workflows shown in the palette. They double as living examples of the schema.

export const SAMPLES = [
  {
    label: 'Account + Contact',
    description: '5 Account, mỗi Account 1–4 Contact',
    workflow: {
      version: 1,
      name: 'Account + Contact',
      nodes: [
        { id: 'start', type: 'start', position: { x: 40, y: 160 }, config: {} },
        { id: 'loopAcc', type: 'loop', position: { x: 300, y: 160 }, config: { mode: 'fixed', count: 5, alias: 'i' } },
        {
          id: 'acc',
          type: 'record',
          position: { x: 580, y: 100 },
          config: {
            sobject: 'Account',
            alias: 'acc',
            count: 1,
            fields: [
              { name: 'Name', type: 'text', options: { mode: 'company', unique: true } },
              { name: 'Industry', type: 'picklist', options: { values: ['Banking', 'Technology', 'Retail', 'Healthcare'], weights: [3, 4, 2, 1] } },
              { name: 'AnnualRevenue', type: 'currency', options: { min: 100000, max: 50000000, scale: 0 } },
              { name: 'Phone', type: 'phone', options: {} },
              { name: 'Website', type: 'url', options: { nullRatio: 0.3 } },
            ],
          },
        },
        { id: 'loopCon', type: 'loop', position: { x: 860, y: 100 }, config: { mode: 'range', min: 1, max: 4, alias: 'loop' } },
        {
          id: 'con',
          type: 'record',
          position: { x: 1140, y: 40 },
          config: {
            sobject: 'Contact',
            alias: 'con',
            count: 1,
            fields: [
              { name: 'FirstName', type: 'text', options: { mode: 'firstName' } },
              { name: 'LastName', type: 'text', options: { mode: 'lastName' } },
              { name: 'Email', type: 'email', options: { mode: 'fromName' } },
              { name: 'Title', type: 'template', options: { template: '{{acc.Industry}} contact #{{loop.index}}' } },
              { name: 'AccountId', type: 'lookup', options: { mode: 'current', ref: 'acc' } },
              { name: 'Birthdate', type: 'date', options: { from: '-60y', to: '-20y' } },
            ],
          },
        },
      ],
      edges: [
        { from: 'start', fromPort: 'next', to: 'loopAcc' },
        { from: 'loopAcc', fromPort: 'body', to: 'acc' },
        { from: 'acc', fromPort: 'next', to: 'loopCon' },
        { from: 'loopCon', fromPort: 'body', to: 'con' },
      ],
    },
  },
  {
    label: 'Lead theo xác suất',
    description: '20 Lead, 30% là Hot kèm Task',
    workflow: {
      version: 1,
      name: 'Lead theo xác suất',
      nodes: [
        { id: 'start', type: 'start', position: { x: 40, y: 160 }, config: {} },
        { id: 'loop', type: 'loop', position: { x: 300, y: 160 }, config: { mode: 'fixed', count: 20, alias: 'loop' } },
        {
          id: 'lead',
          type: 'record',
          position: { x: 580, y: 100 },
          config: {
            sobject: 'Lead',
            alias: 'lead',
            count: 1,
            fields: [
              { name: 'FirstName', type: 'text', options: { mode: 'firstName' } },
              { name: 'LastName', type: 'text', options: { mode: 'lastName' } },
              { name: 'Company', type: 'text', options: { mode: 'company' } },
              { name: 'Email', type: 'email', options: { mode: 'fromName' } },
              { name: 'Status', type: 'picklist', options: { values: ['Open - Not Contacted', 'Working - Contacted'] } },
            ],
          },
        },
        { id: 'hot', type: 'branch', position: { x: 860, y: 100 }, config: { kind: 'chance', probability: 0.3 } },
        {
          id: 'task',
          type: 'record',
          position: { x: 1140, y: 40 },
          config: {
            sobject: 'Task',
            alias: 'task',
            count: 1,
            fields: [
              { name: 'Subject', type: 'template', options: { template: 'Gọi lại {{lead.LastName}}' } },
              { name: 'WhoId', type: 'lookup', options: { mode: 'current', ref: 'lead' } },
              { name: 'ActivityDate', type: 'date', options: { from: 'today', to: '+14d' } },
              { name: 'Priority', type: 'constant', options: { value: 'High' } },
            ],
          },
        },
      ],
      edges: [
        { from: 'start', fromPort: 'next', to: 'loop' },
        { from: 'loop', fromPort: 'body', to: 'lead' },
        { from: 'lead', fromPort: 'next', to: 'hot' },
        { from: 'hot', fromPort: 'true', to: 'task' },
      ],
    },
  },
];
