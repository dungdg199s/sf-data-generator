import { firstNames, lastNames, domains, words, tlds } from '../data/pools.js';
import {
  opt,
  truncate,
  sentence,
  paragraph,
  companyName,
  personName,
  cityName,
  fromPattern,
  slug,
} from './common.js';

const TEXT_MODES = [
  { value: 'words', label: 'Từ ngẫu nhiên' },
  { value: 'name', label: 'Họ tên' },
  { value: 'firstName', label: 'Tên' },
  { value: 'lastName', label: 'Họ' },
  { value: 'company', label: 'Tên công ty' },
  { value: 'city', label: 'Thành phố' },
  { value: 'pattern', label: 'Theo mẫu (#, ?, *)' },
  { value: 'list', label: 'Chọn từ danh sách' },
];

export const text = {
  type: 'text',
  label: 'Text',
  category: 'Text',
  sfTypes: ['string', 'combobox'],
  uniqueable: true,
  options: [
    opt('mode', 'Kiểu nội dung', 'select', 'words', { choices: TEXT_MODES }),
    opt('minWords', 'Số từ tối thiểu', 'integer', 1, { min: 1, showIf: { key: 'mode', in: ['words'] } }),
    opt('maxWords', 'Số từ tối đa', 'integer', 3, { min: 1, showIf: { key: 'mode', in: ['words'] } }),
    opt('pattern', 'Mẫu', 'string', 'ID-####', {
      showIf: { key: 'mode', in: ['pattern'] },
      help: '# = chữ số, ? = chữ hoa, * = chữ hoặc số, \\ để giữ nguyên ký tự.',
    }),
    opt('values', 'Danh sách giá trị', 'list', [], { showIf: { key: 'mode', in: ['list'] }, help: 'Mỗi dòng một giá trị.' }),
    opt('prefix', 'Tiền tố', 'string', ''),
    opt('suffix', 'Hậu tố', 'string', ''),
    opt('maxLength', 'Độ dài tối đa', 'integer', 255, { min: 1, max: 255 }),
  ],
  generate(o, { rng }) {
    let core;
    switch (o.mode) {
      case 'name':
        core = personName(rng);
        break;
      case 'firstName':
        core = rng.pick(firstNames);
        break;
      case 'lastName':
        core = rng.pick(lastNames);
        break;
      case 'company':
        core = companyName(rng);
        break;
      case 'city':
        core = cityName(rng);
        break;
      case 'pattern':
        core = fromPattern(rng, o.pattern || '');
        break;
      case 'list':
        core = o.values.length ? rng.pick(o.values) : '';
        break;
      default: {
        const n = rng.int(o.minWords, Math.max(o.minWords, o.maxWords));
        const parts = [];
        for (let i = 0; i < n; i++) parts.push(rng.pick(words));
        core = parts.join(' ');
      }
    }
    return truncate(`${o.prefix}${core}${o.suffix}`, o.maxLength);
  },
};

export const textarea = {
  type: 'textarea',
  label: 'Text Area',
  category: 'Text',
  sfTypes: ['textarea'],
  options: [
    opt('minSentences', 'Số câu tối thiểu', 'integer', 1, { min: 1 }),
    opt('maxSentences', 'Số câu tối đa', 'integer', 3, { min: 1 }),
    opt('maxLength', 'Độ dài tối đa', 'integer', 255, { min: 1, max: 255 }),
  ],
  generate(o, { rng }) {
    const n = rng.int(o.minSentences, Math.max(o.minSentences, o.maxSentences));
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(sentence(rng));
    return truncate(parts.join(' '), o.maxLength);
  },
};

export const longtextarea = {
  type: 'longtextarea',
  label: 'Text Area (Long)',
  category: 'Text',
  sfTypes: [],
  options: [
    opt('minParagraphs', 'Số đoạn tối thiểu', 'integer', 1, { min: 1 }),
    opt('maxParagraphs', 'Số đoạn tối đa', 'integer', 3, { min: 1 }),
    opt('maxLength', 'Độ dài tối đa', 'integer', 32768, { min: 1, max: 131072 }),
  ],
  generate(o, { rng }) {
    const n = rng.int(o.minParagraphs, Math.max(o.minParagraphs, o.maxParagraphs));
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(paragraph(rng));
    return truncate(parts.join('\n\n'), o.maxLength);
  },
};

export const richtextarea = {
  type: 'richtextarea',
  label: 'Text Area (Rich)',
  category: 'Text',
  sfTypes: [],
  options: [
    opt('minParagraphs', 'Số đoạn tối thiểu', 'integer', 1, { min: 1 }),
    opt('maxParagraphs', 'Số đoạn tối đa', 'integer', 3, { min: 1 }),
    opt('maxLength', 'Độ dài tối đa', 'integer', 32768, { min: 1, max: 131072 }),
  ],
  generate(o, { rng }) {
    const n = rng.int(o.minParagraphs, Math.max(o.minParagraphs, o.maxParagraphs));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const p = paragraph(rng);
      parts.push(i === 0 ? `<p><b>${p.split(' ')[0]}</b> ${p.split(' ').slice(1).join(' ')}</p>` : `<p>${p}</p>`);
    }
    // Never cut through a tag: drop whole paragraphs until it fits.
    while (parts.length > 1 && parts.join('').length > o.maxLength) parts.pop();
    return truncate(parts.join(''), o.maxLength);
  },
};

export const encryptedtext = {
  type: 'encryptedtext',
  label: 'Text (Encrypted)',
  category: 'Text',
  sfTypes: ['encryptedstring'],
  uniqueable: true,
  options: [
    opt('pattern', 'Mẫu', 'string', '****-****-####', { help: '# = chữ số, ? = chữ hoa, * = chữ hoặc số.' }),
    opt('maxLength', 'Độ dài tối đa', 'integer', 175, { min: 1, max: 175 }),
  ],
  generate(o, { rng }) {
    return truncate(fromPattern(rng, o.pattern), o.maxLength);
  },
};

export const email = {
  type: 'email',
  label: 'Email',
  category: 'Text',
  sfTypes: ['email'],
  uniqueable: true,
  uniqueDefault: true,
  options: [
    opt('mode', 'Cách tạo', 'select', 'fromName', {
      choices: [
        { value: 'fromName', label: 'Theo FirstName/LastName của bản ghi' },
        { value: 'random', label: 'Ngẫu nhiên' },
      ],
      help: '"Theo tên" dùng FirstName/LastName đã sinh phía trên trong cùng node, nếu có.',
    }),
    opt('domains', 'Tên miền', 'list', domains, { help: 'Nên dùng tên miền test để không gửi mail thật.' }),
  ],
  generate(o, { rng, record }) {
    const domain = rng.pick(o.domains.length ? o.domains : domains);
    let local;
    if (o.mode === 'fromName') {
      const first = record?.FirstName ?? rng.pick(firstNames);
      const last = record?.LastName ?? rng.pick(lastNames);
      local = `${slug(first)}.${slug(last)}`;
    } else {
      local = `${rng.pick(words)}${rng.digits(3)}`;
    }
    // A numeric tail keeps uniqueness retries productive for common names.
    return `${local}${rng.bool(0.5) ? rng.int(1, 999) : ''}@${domain}`.slice(0, 80);
  },
};

export const phone = {
  type: 'phone',
  label: 'Phone',
  category: 'Text',
  sfTypes: ['phone'],
  uniqueable: true,
  options: [opt('format', 'Định dạng', 'string', '(###) ###-####', { help: '# = chữ số.' })],
  generate(o, { rng }) {
    return fromPattern(rng, o.format).slice(0, 40);
  },
};

export const url = {
  type: 'url',
  label: 'URL',
  category: 'Text',
  sfTypes: ['url'],
  uniqueable: true,
  options: [opt('withPath', 'Thêm đường dẫn', 'boolean', false)],
  generate(o, { rng }) {
    const base = `https://www.${rng.pick(words)}${rng.pick(words)}.${rng.pick(tlds)}`;
    return o.withPath ? `${base}/${rng.pick(words)}/${rng.int(1, 9999)}` : base;
  },
};

export const autonumber = {
  type: 'autonumber',
  label: 'Auto Number',
  category: 'Text',
  sfTypes: [],
  nullable: false,
  options: [
    opt('displayFormat', 'Định dạng', 'string', 'A-{0000}', { help: '{0000} là số thứ tự, đệm số 0.' }),
    opt('startingNumber', 'Bắt đầu từ', 'integer', 1, { min: 0 }),
  ],
  generate(o, { fieldState }) {
    fieldState.counter = (fieldState.counter ?? o.startingNumber - 1) + 1;
    const n = fieldState.counter;
    return o.displayFormat.replace(/\{(0+)\}/, (_, zeros) => String(n).padStart(zeros.length, '0'));
  },
};
