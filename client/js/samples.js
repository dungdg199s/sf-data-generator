// Starter workflows shown in the palette. They double as living examples of the schema
// (workflow JSON version 2). test/samples.test.js checks they validate and that the first two
// are the migrated form of the original v1 samples; the third (design 0006) reads existing
// Accounts with a Query step (sample rows when no org is selected); the fourth (design 0010)
// loops over each of them.

export const SAMPLES = [
  {
    label: 'Account + Contact',
    description: '5 Account, mỗi Account 1–4 Contact',
    workflow: {
      version: 2,
      name: 'Account + Contact',
      steps: [
        {
          id: 'loopAcc',
          type: 'loop',
          config: { mode: 'fixed', count: 5, alias: 'i' },
          slots: {
            body: [
              {
                id: 'acc',
                type: 'record',
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
              {
                id: 'loopCon',
                type: 'loop',
                config: { mode: 'range', min: 1, max: 4, alias: 'loop' },
                slots: {
                  body: [
                    {
                      id: 'con',
                      type: 'record',
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
                },
              },
            ],
          },
        },
      ],
    },
  },
  {
    label: 'Lead theo xác suất',
    description: '20 Lead, 30% là Hot kèm Task',
    workflow: {
      version: 2,
      name: 'Lead theo xác suất',
      steps: [
        {
          id: 'loop',
          type: 'loop',
          config: { mode: 'fixed', count: 20, alias: 'loop' },
          slots: {
            body: [
              {
                id: 'lead',
                type: 'record',
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
              {
                id: 'hot',
                type: 'branch',
                config: { kind: 'chance', probability: 0.3 },
                slots: {
                  true: [
                    {
                      id: 'task',
                      type: 'record',
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
                  false: [],
                },
              },
            ],
          },
        },
      ],
    },
  },
  {
    label: 'Contact cho Account có sẵn',
    description: 'Đọc Account trong org, 10 Contact gắn vào Account có sẵn',
    workflow: {
      version: 2,
      name: 'Contact cho Account có sẵn',
      steps: [
        {
          id: 'accs',
          type: 'query',
          config: { mode: 'builder', sobject: 'Account', alias: 'accs', fields: ['Id', 'Name'], where: '', orderBy: 'Id', limit: 200 },
        },
        {
          id: 'loopCon',
          type: 'loop',
          config: { mode: 'fixed', count: 10, alias: 'loop' },
          slots: {
            body: [
              { id: 'acc', type: 'pick', config: { from: 'accs', alias: 'acc', mode: 'random', filter: 'none', onEmpty: 'skip' } },
              {
                id: 'con',
                type: 'record',
                config: {
                  sobject: 'Contact',
                  alias: 'con',
                  count: 1,
                  fields: [
                    { name: 'FirstName', type: 'text', options: { mode: 'firstName' } },
                    { name: 'LastName', type: 'text', options: { mode: 'lastName' } },
                    { name: 'Email', type: 'email', options: { mode: 'fromName' } },
                    { name: 'Title', type: 'template', options: { template: 'Liên hệ của {{acc.Name}}' } },
                    { name: 'AccountId', type: 'lookup', options: { mode: 'current', ref: 'acc', referenceTo: ['Account'] } },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  },
  {
    label: 'Contact cho mỗi Account có sẵn',
    description: 'Đọc Account trong org, mỗi Account 3 Contact (Lặp theo từng bản ghi)',
    workflow: {
      version: 2,
      name: 'Contact cho mỗi Account có sẵn',
      steps: [
        {
          id: 'accs',
          type: 'query',
          config: { mode: 'builder', sobject: 'Account', alias: 'accs', fields: ['Id', 'Name'], where: '', orderBy: 'Id', limit: 200 },
        },
        {
          id: 'eachAcc',
          type: 'loop',
          config: { mode: 'each', from: 'accs', itemAlias: 'acc', alias: 'loop' },
          slots: {
            body: [
              {
                id: 'con',
                type: 'record',
                config: {
                  sobject: 'Contact',
                  alias: 'con',
                  count: 3,
                  fields: [
                    { name: 'FirstName', type: 'text', options: { mode: 'firstName' } },
                    { name: 'LastName', type: 'text', options: { mode: 'lastName' } },
                    { name: 'Title', type: 'template', options: { template: 'Liên hệ của {{acc.Name}} (Account {{loop.index}}/{{loop.count}})' } },
                    { name: 'AccountId', type: 'lookup', options: { mode: 'current', ref: 'acc', referenceTo: ['Account'] } },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  },
];
