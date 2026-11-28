(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const legacy = new URL(location.href);
  if (legacy.searchParams.get('mode') === 'problems') {
    legacy.pathname = '/problem-space.html';
    legacy.searchParams.delete('mode');
    legacy.searchParams.set('legacy', '1');
    location.replace(legacy);
    return;
  }
  const fields = [['problem','Проблема и текущий процесс'],['target','Цели, таргет и антицели'],['metric_validation','Метрики'],['dataset','Датасет'],['validation','Валидация'],['model_training','Решение, альтернативы и обучение']];
  const query=new URLSearchParams(location.search),project=query.get('project');
  if(/^[a-f0-9-]{36}$/.test(project||''))$('back-schema').href+='?project='+encodeURIComponent(project);
  let account=null,doc=null,release=null,dirty=false,conflicted=false,blocked=false,saving=null,working=false,mode='mine',preview=null;
  const draftKey=()=>`architect.design-document.${account.id}.${doc.id}`;
  function node(tag,text,cls=''){const e=document.createElement(tag);e.textContent=text;e.className=cls;return e;}
  function message(text=''){ $('message').textContent=text;$('message').hidden=!text; }
  function error(text='',target='editor-error'){const e=$(target);e.textContent=text;e.hidden=!text;if(text&&!e.closest('[hidden]')){e.tabIndex=-1;e.focus({preventScroll:true});e.scrollIntoView({block:'nearest'});}}
  async function api(action,body={},community=false){
    if (['compose','review','task-sources'].includes(action)) body = {...window.designFlow.aiScope(), ...body};
    let r;try{r=await fetch('/api/'+(community === true ? 'community/' : typeof community === 'string' ? community + '/' : 'design-documents/')+action,{method:'POST',headers:{'Content-Type':'application/json','X-Architect-Request':'1',...(account?{'X-Architect-Account':account.id}:{})},body:JSON.stringify(body)});}catch{throw Error('Не удалось связаться с сервером. Повторите попытку; введённый текст сохранён в редакторе.');}
    const data=await r.json();if(!r.ok){const e=Error(data.error||'Не удалось выполнить запрос.');e.status=r.status;throw e;}return data;
  }
  window.setupMethodEditor({
    first:'compose',
    load:() => api('method'),
    save:changes => api('save-method', {changes})
  });
  const assistant = window.setupDesignAssistant({fields, api, read:value, changed, getId:()=>doc?.id, linksChanged:syncSteps});
  function syncSteps(links) {
    window.designFlow.documentOpened(doc?.id, Boolean(doc && !doc.revision), links);
  }
  function value(){return {task_links:assistant.taskLinks(),sources:assistant.sources(),title:$('title').value,sections:Object.fromEntries(fields.map(([k])=>[k,$('section-'+k).value]))};}
  function same(a,b){return JSON.stringify(a.task_links||{})===JSON.stringify(b.task_links||{})&&JSON.stringify(a.sources||{})===JSON.stringify(b.sources||{})&&a.title===b.title&&fields.every(([k])=>a.sections[k]===b.sections[k]);}
  function controls(){ $('compose-doc').disabled=!!saving||conflicted||blocked;$('save').disabled=(!dirty&&!!doc?.revision)||!!saving||conflicted||blocked;$('conflict').hidden=!conflicted;$('save-status').textContent=doc?(saving?'Сохранение…':dirty?'Есть несохранённые изменения':doc.revision?'Все изменения сохранены':'Новый документ · ещё не сохранён'):''; }
  function cache(){if(!doc||release)return;try{if(dirty)localStorage.setItem(draftKey(),JSON.stringify({...value(),revision:doc.revision,initial_task_title:doc.title}));else localStorage.removeItem(draftKey());}catch{error('Браузер не сохранил резервную копию. Сохраните документ на сервер перед закрытием.');}}
  function changed() {
    for (const key of ['dataset', 'metric_validation', 'validation']) {
      const insert = $(key + '-insert');
      if (insert) insert.hidden = !!$('section-' + key).value.trim();
    }
    refreshSectionViews();
    refreshOutline(key => $('section-' + key).value);
    dirty = !same(value(), doc);
    cache();
    controls();
  }
  const datasetOutline = [
    ['ETL', 'Что означает один пример? Из каких источников, за какой период и по каким ключам собирается выборка? Где и в каком формате она хранится, как часто обновляется?'],
    ['Фильтрация', 'Какие примеры включаем или исключаем? Как обрабатываем пропуски, дубли, шум и редкие случаи? Что проверяем вручную?'],
    ['Генерация признаков', 'Из каких исходных полей и метаданных вычисляем признаки или эмбеддинги? Какие преобразования и окна используем? Что известно на момент прогноза?'],
    ['Разметка', 'Какая метка нужна и откуда она берётся? Если её ставит человек, как описаны классы, спорные примеры и проверка качества?']
  ];
  const validationOutline = [
    ['Сценарий применения', 'Кому и когда выдаём прогноз? Что известно к этому моменту и когда появится метка? Что будет новым для модели: период, клиент или объект?'],
    ['Разбиение и защита от утечек', 'По какой единице делим данные? Где могут пересечься пользователи, дубли или близкие примеры? Для прогноза во времени укажите горизонт, задержку данных и нужный зазор.'],
    ['Выбор модели и финальная проверка', 'Где выбираем признаки, порог и гиперпараметры? Какие данные оставляем для независимой оценки? Сравните модель с базовым решением на одних примерах и укажите, как оцените неопределённость разницы.'],
    ['Обновление выборок', 'Куда попадут новые наблюдения? Когда сдвигаем окно, сохраняем доли или используем фиксированный эталонный набор? Как воспроизведём сравнение версий?']
  ];
  function guideList(items) {
    const list = document.createElement('dl');
    for (const [heading, text] of items) list.append(node('dt', heading), node('dd', text));
    return list;
  }
  function outlineGuide(input, title, outline) {
    const guide = node('div', '', 'dataset-guide');
    const help = document.createElement('details');
    help.append(node('summary', title), guideList(outline));
    const insert = structureButton(input, outline);
    if (input.id === 'section-validation') {
      guide.classList.add('validation-guide');
      guide.append(insert, help);
    } else {
      guide.append(help, insert);
    }
    return guide;
  }
  function structureButton(input, outline) {
    const insert = node('button', 'Вставить структуру');
    insert.type = 'button';
    insert.id = input.id.replace('section-', '') + '-insert';
    insert.hidden = !!input.value.trim();
    insert.onclick = () => {
      if (input.value.trim()) return;
      input.value = outline.map(([heading]) => '## ' + heading + '\n').join('\n');
      input.dispatchEvent(new Event('input', {bubbles:true}));
      sectionViews.get(input.id.replace('section-', '')).editor.focus();
    };
    return insert;
  }
  function metricsGuide(input) {
    const help = node('details', '', 'metrics-guide');
    help.append(node('summary', 'Памятка — функция потерь, офлайн- и онлайн-метрики'));
    const list = document.createElement('dl');
    const items = [
      ['Функция потерь', 'Что модель минимизирует при обучении? Укажите функцию, причину выбора и веса ошибок. Учтите, одинаково ли стоят недооценка и переоценка. Например, в прогнозе спроса квантильная функция потерь позволяет учитывать разную цену дефицита и избытка.'],
      ['Офлайн-метрики', 'Как сравниваем модели до внедрения? Укажите метрику, отложенную выборку, базовую модель и важные срезы. Проверьте влияние баланса классов и устойчивость результатов. Например, качество поиска можно оценить по NDCG или MRR на размеченных запросах.'],
      ['Онлайн-метрики', 'Как измеряем эффект работающей системы для пользователей и бизнеса? Укажите основной показатель, контрольный вариант, окно наблюдения и способ проверки эффекта, например A/B-тест. Запишите показатели, ухудшение которых недопустимо. Для поиска это могут быть покупки, выручка и поведение пользователей.']
    ];
    for (const [heading, text] of items) list.append(node('dt', heading), node('dd', text));
    help.append(list, node('p', 'Для каждой метрики задайте определение или формулу, единицу измерения и направление улучшения. Объясните связь с бизнес-целью и способ её проверки. Рост кликов может сопровождаться отсутствием роста покупок — проверку этой гипотезы стоит зафиксировать в документе.'));
    const guide = node('div', '', 'dataset-guide');
    guide.append(help, structureButton(input, items));
    return guide;
  }
  const sectionViews = new Map();
  // Section outline: shows which parts of the document are filled and jumps to them.
  function renderOutline(read, editable) {
    const outline = $('doc-outline'), list = document.createElement('ol');
    outline.replaceChildren(node('p', '', 'outline-count'), list);
    for (const [key, label] of fields) {
      const link = node('a', label);
      link.href = '#doc-section-' + key;
      link.dataset.key = key;
      link.append(node('span', '', 'visually-hidden'));
      link.onclick = event => {
        event.preventDefault();
        // The editor's own focus() scrolls to the caret and cancels the smooth scroll.
        if (editable) sectionViews.get(key)?.editable.focus({preventScroll: true});
        const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.getElementById('doc-section-' + key).scrollIntoView({block: 'start', behavior: smooth ? 'smooth' : 'auto'});
      };
      const item = node('li', '');
      item.append(link);
      list.append(item);
    }
    refreshOutline(read);
  }
  function refreshOutline(read) {
    const links = [...$('doc-outline').querySelectorAll('a')];
    let filled = 0;
    for (const link of links) {
      const done = !!String(read(link.dataset.key) || '').trim();
      filled += done;
      link.classList.toggle('filled', done);
      link.lastChild.textContent = done ? ', заполнено' : ', пусто';
    }
    const count = $('doc-outline').querySelector('.outline-count');
    if (count) count.textContent = 'Заполнено: ' + filled + ' из ' + links.length;
  }
  function refreshSectionViews() {
    for (const view of sectionViews.values()) view.refresh();
  }
  function sanitizeEditorHTML(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const content = template.content;
    for (const unsafe of content.querySelectorAll('script,style,iframe,object,embed,img,svg,math,form,input,button,link,meta,video,audio,source,base,template')) unsafe.remove();
    for (const el of content.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (!['href','title','class','colspan','rowspan','data-language','data-task','data-task-checked'].includes(attr.name)) el.removeAttribute(attr.name);
      }
      if (el.hasAttribute('href') && !/^(https?:|mailto:)/i.test(el.getAttribute('href'))) el.removeAttribute('href');
    }
    return template.innerHTML;
  }
  function sectionEditor(input, key) {
    const host = node('div', '', 'visual-editor');
    input.hidden = true;
    let syncing = true;
    const editor = new toastui.Editor({
      el: host, initialValue: input.value, initialEditType: 'wysiwyg',
      hideModeSwitch: true, height: 'auto', minHeight: '240px',
      language: 'ru-RU', usageStatistics: false, autofocus: false,
      toolbarItems: [['heading', 'bold', 'italic', 'strike'], ['quote', 'ul', 'ol', 'task'],
        ['table', 'link'], ['code', 'codeblock']],
      customHTMLSanitizer: sanitizeEditorHTML,
      plugins: [({pmState}) => ({
        wysiwygPlugins: [() => new pmState.Plugin({props: {transformPastedHTML: sanitizeEditorHTML}})]
      })]
    });
    const editable = host.querySelector('.toastui-editor-ww-container [contenteditable=true]');
    editable.setAttribute('role', 'textbox');
    editable.setAttribute('aria-multiline', 'true');
    editable.setAttribute('aria-labelledby', 'label-' + key);
    editable.addEventListener('beforeinput', event => {
      if (event.inputType !== 'insertText' || event.data !== ' ' || event.isComposing || !event.cancelable) return;
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      if (!selection?.isCollapsed || !selection.rangeCount) return;
      const paragraph = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
      if (paragraph.tagName !== 'P' || paragraph.parentElement !== editable) return;
      const prefix = selection.getRangeAt(0).cloneRange();
      prefix.setStart(paragraph, 0);
      const marker = prefix.toString();
      if (!/^(#{1,6}|[-*+]|1\.)$/.test(marker)) return;
      event.preventDefault();
      const [position] = editor.getSelection();
      editor.deleteSelection(position - marker.length, position);
      if (marker.startsWith('#')) editor.exec('heading', {level: marker.length});
      else editor.exec(marker === '1.' ? 'orderedList' : 'bulletList');
    }, true);
    editor.on('change', () => {
      if (syncing) return;
      input.value = editable.textContent.trim() || editable.querySelector('table,hr') ? editor.getMarkdown() : '';
      rendered = input.value;
      input.dispatchEvent(new Event('input', {bubbles:true}));
    });
    let rendered = input.value;
    sectionViews.set(key, {editor, editable, refresh() {
      if (rendered === input.value || editor.getMarkdown() === input.value) {
        rendered = input.value;
        return;
      }
      syncing = true;
      editor.setMarkdown(input.value, false);
      rendered = input.value;
      syncing = false;
    }});
    syncing = false;
    return [input, host];
  }
  function renderSections(parent, data, editable) {
    if (editable) {
      for (const view of sectionViews.values()) view.editor.destroy();
      sectionViews.clear();
    }
    parent.replaceChildren();
    fields.forEach(([key, label], index) => {
      const section = node('section', '', 'doc-section');
      section.id = 'doc-section-' + key;
      if (editable) {
        const title = node('label', (index + 1) + '. ' + label);
        title.id = 'label-' + key;
        const input = document.createElement('textarea');
        input.id = title.htmlFor = 'section-' + key;
        input.value = data[key] ?? '';
        input.addEventListener('input', changed);
        section.append(title);
        if (key === 'metric_validation') section.append(metricsGuide(input));
        if (key === 'dataset') {
          input.placeholder = 'ETL · Фильтрация · Генерация признаков · Разметка';
          section.append(outlineGuide(input, 'Что описать в каждом подразделе', datasetOutline));
        }
        if (key === 'validation') {
          section.append(outlineGuide(input, 'Памятка — как выбрать схему валидации', validationOutline));
        }
        section.append(...sectionEditor(input, key));
        title.onclick = () => sectionViews.get(key).editor.focus();
      } else {
        section.append(node('h3', (index + 1) + '. ' + label), window.ChatMarkdown(data[key] || 'Не заполнено'));
      }
      parent.append(section);
    });
    if (editable) requestAnimationFrame(refreshSectionViews);
    renderOutline(key => editable ? $('section-' + key).value : data[key], editable);
  }
  function updateURL(values) {
    const url = new URL(location.pathname, location.origin);
    if (project) url.searchParams.set('project', project);
    if (values.new) {
      const links = assistant.taskLinks();
      if (links.tree_id) url.searchParams.set('tree', links.tree_id);
      if (links.metric_tree_id) url.searchParams.set('metric', links.metric_tree_id);
    }
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    history.replaceState(null, '', url);
  }
  async function save(){
    if(saving)return saving;if(!dirty&&doc.revision)return true;if(conflicted||blocked)return false;
    const sent=value();if(!sent.title.trim()){error('Введите название документа.');$('title').focus();return false;}
    saving=(async()=>{try{
      const initial = doc.revision ? {} : {initial_task_links:doc.task_links || {}, initial_task_title:doc.title};
      const result = await api(doc.revision?'save':'create', {id:doc.id, revision:doc.revision, ...initial, ...sent});
      doc = result.document;
      if ($('title').value === sent.title) $('title').value = doc.title;
      document.title = doc.title + ' · Дизайн-документ';
      if (JSON.stringify(assistant.taskLinks()) === JSON.stringify(sent.task_links) &&
          JSON.stringify(sent.task_links) !== JSON.stringify(doc.task_links)) assistant.load(assistant.sources(), doc.task_links);
      syncSteps(assistant.taskLinks());updateURL({id:doc.id});dirty=!same(value(),doc);cache();error();message('Документ сохранён.');return true;}
      catch(e){if(e.status===409&&e.message.includes('другой вкладке'))conflicted=true;else if(e.status===401||e.status===404||e.status===409)blocked=true;error(e.message);return false;}
      finally{saving=null;controls();}})();controls();return saving;
  }
  async function leaveEditor(){
    if(saving){await saving;return false;}
    if(!doc||release||!dirty)return true;
    if(!confirm('Выйти без сохранения? Несохранённые изменения будут потеряны. Чтобы сохранить текст, нажмите «Отмена», затем «Сохранить».'))return false;
    return true;
  }
  function discardDraft(){if(doc){try{localStorage.removeItem(draftKey());}catch{}}dirty=false;}
  async function task(fn){if(working)return;working=true;try{await fn();}catch(e){if($('editor').hidden)message(e.message);else error(e.message);}finally{working=false;}}
  function openEditor(document,restore=true){
    doc=document;release=null;dirty=false;conflicted=false;blocked=false;let content=document;
    error();message();
    if(restore){try{const draft=JSON.parse(localStorage.getItem(draftKey())||'null');
      for (const key of ['dataset', 'validation']) {
        if (draft?.sections && !Object.hasOwn(draft.sections, key)) {
          draft.sections[key] = document.sections[key];
          if (document.sources?.[key]) draft.sources = {...draft.sources, [key]: document.sources[key]};
        }
      }
      if(typeof draft?.sections?.data_features === 'string') {
        const addition='Генерация признаков (из прежнего раздела)\n'+draft.sections.data_features;
        if(draft.sections.data_features.trim() && !draft.sections.dataset.includes(addition))
          draft.sections.dataset=(draft.sections.dataset+'\n\n'+addition).replace(/^\n+/, '');
        delete draft.sections.data_features;
      }
      if (draft && draft.title === draft.initial_task_title) draft.title = document.title;
      if (draft) {
        const savedLinks = document.task_links || {}, oldLinks = draft.task_links || {};
        draft.task_links = {...savedLinks};
        if (savedLinks.tree_id && oldLinks.tree_id === savedLinks.tree_id && Array.isArray(oldLinks.cases)) {
          Object.assign(draft.task_links, {cases:oldLinks.cases, case_version:oldLinks.case_version});
        }
      }
      if(draft&&typeof draft.title==='string'&&fields.every(([k])=>typeof draft.sections?.[k]==='string')){
      if(same(draft,document))localStorage.removeItem(draftKey());else{content=draft;dirty=true;conflicted=draft.revision!==document.revision;message('Восстановлены несохранённые изменения из этого браузера.');}
    }}catch{error('Не удалось прочитать локальный черновик.');}}
    window.document.title = content.title + ' · Дизайн-документ';
    $('design-flow').hidden=false;
    $('auth').hidden=true;$('list').hidden=true;$('editor').hidden=false;$('title-label').hidden=false;$('title').hidden=false;$('title').value=content.title;$('read-title').hidden=true;
    $('save').hidden=false;$('download-pdf').hidden=false;$('copy').hidden=true;$('publication-info').hidden=!doc.source_release;
    $('publication-info').textContent=doc.source_release?'Личная копия публикации. Ваши изменения не затрагивают оригинал.':'';
    renderSections($('sections'),content.sections,true);$('doc-assist').hidden=false;syncSteps(content.task_links || {});assistant.load(content.sources,content.task_links);updateURL(doc.revision?{id:doc.id}:{new:doc.id});$('back-list').textContent='← К задачам';controls();window.scrollTo(0,0);
  }
  async function open(id){const result=await api('get',{id});openEditor(result.document);}
  function retryId(kind){const k='architect.design-pending.'+account.id+'.'+kind;let id;try{id=sessionStorage.getItem(k);}catch{}id ||= crypto.randomUUID();try{sessionStorage.setItem(k,id);}catch{}return {id,clear(){try{sessionStorage.removeItem(k);}catch{}}};}
  async function create(id, taskLinks={}){
    if (!id && !taskLinks.tree_id && !taskLinks.metric_tree_id) id = crypto.randomUUID();
    const task = await window.designFlow.resolveTask({doc:id, tree:taskLinks.tree_id, metric:taskLinks.metric_tree_id});
    if (!task.draft) return open(task.id);
    id = task.id;
    const {title, links} = task;
    openEditor({id,task_links:links,title:title || 'Новый дизайн-документ',sections:Object.fromEntries(fields.map(([k])=>[k,''])),revision:0});
    if (!title) { $('title').focus(); $('title').select(); }
  }
  const pluralRules = new Intl.PluralRules('ru');
  function quantity(count, one, few, many) {
    return count + ' ' + ({one, few}[pluralRules.select(count)] || many);
  }

  const stageLabels = {problems:'Проблемы', solutions:'Решения', metrics:'Метрики', document:'Документ'};

  function taskTable(rows) {
    const table = node('table', '', 'task-table');
    table.setAttribute('aria-label', 'Задачи');
    const header = table.createTHead().insertRow();
    for (const label of ['Задача', ...Object.values(stageLabels), 'Действия']) {
      const cell = node('th', label);
      cell.scope = 'col';
      header.append(cell);
    }
    table.createTBody().append(...rows);
    return table;
  }

  function taskRow(row) {
    const {problem, metric} = row;
    const context = {tree:problem?.id, metric:metric?.id, doc:row.id || row.draft_id, draft:!row.id};
    const stepUrl = step => window.designFlow.url(step, context);
    const item = node('tr', '', 'task-row');
    const heading = node('th', '');
    heading.scope = 'row';
    const title = node('a', row.title, 'document-row');
    function resume() {
      const visit = window.designFlow.lastVisit(context);
      title.href = stepUrl(visit?.step || 'problems');
      item.dataset.activity = Math.max(row.updated, problem?.updated || 0, metric?.updated || 0, (visit?.time || 0) / 1000);
    }
    resume();
    item.refreshVisit = resume;
    heading.append(title);
    item.append(heading);
    const actionCell = node('td', '', 'task-action-cell');
    const menu = node('details', '', 'task-menu');
    menu.name = 'task-actions';
    const toggle = node('summary', '⋯');
    toggle.dataset.taskId = context.doc;
    toggle.setAttribute('aria-label', 'Действия с задачей «' + row.title + '»');
    const actions = node('div', '', 'task-row-actions');
    menu.append(toggle, actions);
    actionCell.append(menu);
    const rename = node('button', 'Переименовать');
    rename.setAttribute('aria-label', 'Переименовать задачу «' + row.title + '»');
    rename.onclick = () => {
      menu.open = false;
      toggle.focus();
      showNameDialog(row);
    };
    const remove = node('button', 'Удалить', 'delete-document');
    const label = (row.id ? 'Удалить документ «' : 'Удалить задачу «') + row.title + '»';
    remove.setAttribute('aria-label', label);
    remove.onclick = () => task(async () => {
      remove.disabled = true;
      const index = shownTitles().indexOf(title);
      try {
        const members = {};
        if (problem) members.problem = {id:problem.id, revision:problem.revision, case_version:problem.case_version};
        if (metric) members.metric = {id:metric.id, revision:metric.revision};
        const result = row.id ? await api('delete', {id:row.id, revision:row.revision}) :
          await api('delete-draft', {id:row.draft_id, members});
        try {
          localStorage.removeItem('architect.design-document.' + account.id + '.' + result.deleted);
          localStorage.removeItem(window.designFlow.historyPrefix + result.deleted);
          for (const [kind, id] of Object.entries(result.removed_trees || {})) {
            const prefix = kind === 'problem' ? 'architect.problem-space' : 'architect.metric-tree';
            localStorage.removeItem(prefix + '.draft.' + id);
            if (localStorage.getItem(prefix + '.last') === id) localStorage.removeItem(prefix + '.last');
          }
        } catch {}
        await list();
        message(row.id ? 'Документ удалён.' : 'Задача удалена.');
        const links = shownTitles();
        (links[Math.min(index, links.length - 1)] || $('create')).focus();
      } finally { remove.disabled = false; }
    });
    if (row.shared) {
      const separate = node('button', 'Отделить общие деревья');
      separate.title = 'Создать независимые копии деревьев и кейсов для этой задачи';
      separate.onclick = () => task(async () => {
        separate.disabled = true;
        try {
          await api('separate-shared', {id:context.doc});
          await list();
          message('Деревья этой задачи теперь независимы.');
          $('documents').querySelector(`[data-task-id="${context.doc}"]`)?.focus();
        } finally { separate.disabled = false; }
      });
      actions.append(separate);
    }
    actions.append(rename, remove);

    function addStep(key, status, progress) {
      const cell = node('td');
      const link = node('a', '', 'task-step');
      link.href = stepUrl(key);
      link.setAttribute('aria-label', stageLabels[key] + ' ' + status);
      link.append(node('span', stageLabels[key], 'task-stage-label'));
      if (progress) {
        const {value, total} = progress;
        const track = node('span', '', 'task-track');
        track.setAttribute('aria-hidden', 'true');
        if (key === 'document') {
          for (let i = 0; i < total; i++) track.append(node('span', '', i < value ? 'filled' : ''));
        } else {
          const fill = node('span', '', 'filled');
          fill.style.width = (100 * value / total) + '%';
          track.append(fill);
        }
        link.append(track, node('span', value + '/' + total, 'task-fraction'));
      } else {
        link.append(node('span', status));
      }
      cell.append(link);
      item.append(cell);
    }

    addStep('problems', problem?.questions ? problem.answered + ' из ' + quantity(problem.questions, 'ответа', 'ответов', 'ответов') :
      row.missing_problem ? 'дерево недоступно' : 'нет вопросов', problem?.questions && {value:problem.answered, total:problem.questions});
    addStep('solutions', problem?.cases ? quantity(problem.cases, 'кейс', 'кейса', 'кейсов') : 'нет кейсов');
    addStep('metrics', metric ? quantity(metric.count, 'показатель', 'показателя', 'показателей') :
      row.missing_metric ? 'дерево недоступно' : 'не выбраны');
    addStep('document', row.id ? row.filled + ' из ' + quantity(fields.length, 'раздела', 'разделов', 'разделов') : 'не создан',
      row.id && {value:row.filled, total:fields.length});
    item.append(actionCell);
    return item;
  }

  // The search field narrows the task list by title; «ё» and «е» match each other.
  const fold = text => text.toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const shownTitles = () => [...$('documents').querySelectorAll('.task-row:not([hidden]) .document-row')];
  function filterTasks() {
    const rows = [...$('documents').querySelectorAll('.task-row')];
    $('task-filter-row').hidden = mode !== 'mine' || !rows.length;
    if (!rows.length) $('task-filter').value = '';
    const typed = $('task-filter').value.trim(), query = fold(typed);
    for (const row of rows) row.hidden = !fold(row.querySelector('.document-row').textContent).includes(query);
    const found = shownTitles().length;
    const table = $('documents').querySelector('.task-table');
    if (table) table.hidden = !found;
    $('task-filter-empty').hidden = !rows.length || found > 0;
    $('task-filter-empty').textContent = rows.length && !found ? 'По запросу «' + typed + '» задач нет.' : '';
  }
  $('task-filter').addEventListener('input', filterTasks);

  document.addEventListener('click', event => {
    const menu = $('documents').querySelector('.task-menu[open]');
    if (menu && !menu.contains(event.target)) menu.open = false;
  });
  $('documents').addEventListener('keydown', event => {
    const menu = event.target.closest('.task-menu[open]');
    if (menu && event.key === 'Escape') {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });

  const byActivity = (first, second) => second.dataset.activity - first.dataset.activity;
  window.addEventListener('storage', event => {
    if (!$('list').hidden && event.key?.startsWith(window.designFlow.historyPrefix)) {
      const rows = [...$('documents').querySelectorAll('.task-row')];
      for (const row of rows) row.refreshVisit();
      const ordered = [...rows].sort(byActivity);
      if (ordered.some((row, i) => row !== rows[i])) rows[0].parentElement.append(...ordered);
    }
  });
  async function list(next='mine') {
    if (!await leaveEditor()) return;
    const mine = next === 'mine';
    const result = mine ? await api('list', {include_progress:true}) :
      await api('catalog', {kind:'design_document', search:$('search').value}, true);
    discardDraft();
    mode=next;doc=null;release=null;syncSteps({});dirty=false;error();message();
    $('auth').hidden=true;$('editor').hidden=true;$('list').hidden=false;$('search-form').hidden=mine;
    $('design-flow').hidden=true;
    $('mine').setAttribute('aria-current',mine?'page':'false');$('catalog').setAttribute('aria-current',mine?'false':'page');
    updateURL({view:mode});
    document.title = 'Задачи · Архитектор';
    const documents = $('documents');
    documents.replaceChildren();
    if (mine) {
      const rows = [...result.documents, ...result.unlinked].map(taskRow);
      if (rows.length) documents.append(taskTable(rows.sort(byActivity)));
      else documents.append(node('p', 'Задач пока нет.', 'muted'));
    } else {
      for (const row of result.releases) {
        const button = node('button', '', 'document-row');
        button.append(node('strong', row.name), node('small', '@' + row.username + ' · версия ' + row.number));
        button.onclick = () => task(() => openRelease(row.id));
        documents.append(button);
      }
      if (!result.releases.length) documents.append(node('p', $('search').value ? 'По этому запросу документов нет.' :
        'В сообществе пока нет опубликованных дизайн-документов.', 'muted'));
    }
    filterTasks();
    window.scrollTo(0,0);
  }
  async function openRelease(id){
    const result=await api('release',{release_id:id},true);if(result.kind!=='design_document')throw Error('Это не публикация дизайн-документа.');
    release=result;doc=null;dirty=false;conflicted=false;blocked=false;error();message();
    window.document.title = 'Дизайн-документ · Архитектор';
    $('design-flow').hidden=false;
    $('auth').hidden=true;$('list').hidden=true;$('editor').hidden=false;$('title-label').hidden=true;$('title').hidden=true;$('read-title').hidden=false;$('read-title').textContent=result.name;
    $('save').hidden=true;$('download-pdf').hidden=true;$('copy').hidden=false;$('publication-info').hidden=false;$('publication-info').textContent=`@${result.username} · версия ${result.number} · Опубликованный документ`;
    $('doc-assist').hidden=true;renderSections($('sections'),result.package.sections,false);updateURL({release:id});$('back-list').textContent='← Каталог сообщества';controls();window.scrollTo(0,0);
  }
  $('title').addEventListener('input',changed);
  $('save').onclick=()=>task(save);
  let namingRow, namingId;
  function showNameDialog(row) {
    namingRow = row;
    namingId = row ? row.id || row.draft_id : crypto.randomUUID();
    $('create-task-heading').textContent = row ? 'Переименовать задачу' : 'Создать задачу';
    $('submit-task').textContent = row ? 'Сохранить' : 'Создать';
    $('create-task-form').reset();
    $('task-name').setCustomValidity('');
    $('create-task-error').hidden = true;
    $('task-name').value = row?.title || '';
    $('create-task-dialog').showModal();
    $('task-name').select();
  }
  $('create').onclick = () => showNameDialog(null);
  $('task-name').oninput = () => $('task-name').setCustomValidity('');
  $('cancel-task').onclick = () => $('create-task-dialog').close();
  $('create-task-dialog').oncancel = event => { if ($('submit-task').disabled) event.preventDefault(); };
  $('create-task-form').onsubmit = async event => {
    event.preventDefault();
    if ($('submit-task').disabled) return;
    const input = $('task-name');
    const title = input.value.trim();
    if (!title) {
      input.setCustomValidity('Введите название задачи.');
      input.reportValidity();
      return;
    }
    $('submit-task').disabled = $('cancel-task').disabled = input.readOnly = true;
    try {
      if (namingRow) {
        await api('rename-task', {id:namingId, title, previous_title:namingRow.title,
          tree_id:namingRow.problem?.id, metric_tree_id:namingRow.metric?.id});
        await list();
        $('create-task-dialog').close();
        // A renamed task can drop out of the current search: return to the search field then.
        ($('documents').querySelector(`.task-row:not([hidden]) summary[data-task-id="${namingId}"]`) || $('task-filter')).focus();
        message('Название сохранено.');
      } else {
        await api('create-task', {id:namingId, title});
        location.assign(window.designFlow.url('problems', {doc:namingId, draft:true}));
      }
    } catch (err) {
      $('create-task-error').textContent = err.message;
      $('create-task-error').hidden = false;
    } finally {
      $('submit-task').disabled = $('cancel-task').disabled = input.readOnly = false;
    }
  };
  $('mine').onclick=()=>task(()=>list('mine'));$('catalog').onclick=()=>task(()=>list('catalog'));
  $('search-form').onsubmit=e=>{e.preventDefault();task(()=>list('catalog'));};$('back-list').onclick=()=>task(()=>list(release?'catalog':'mine'));
  $('back-schema').onclick=e=>{if(!doc||(!dirty&&!saving))return;e.preventDefault();task(async()=>{if(await leaveEditor()){discardDraft();location.href=$('back-schema').href;}});};
  $('copy').onclick=()=>task(async()=>{const attempt=retryId('copy.'+release.id),r=await api('copy',{id:attempt.id,release_id:release.id});attempt.clear();openEditor(r.document);message('Документ сохранён в списке задач.');});
  $('save-separate').onclick=()=>task(async()=>{const attempt=retryId('separate.'+doc.id),oldKey=draftKey();const r=await api('duplicate',{id:attempt.id,original_id:doc.id,...value()});try{localStorage.removeItem(oldKey);}catch{}attempt.clear();openEditor(r.document,false);message('Ваш вариант сохранён отдельным документом.');});
  $('reload-saved').onclick=()=>task(async()=>{if(!confirm('Загрузить сохранённую версию? Несохранённый текст в этой вкладке будет заменён.'))return;const r=await api('get',{id:doc.id});try{localStorage.removeItem(draftKey());}catch{}openEditor(r.document,false);});
  $('download-pdf').onclick = async () => {
    const button = $('download-pdf');
    const data = value();
    const sections = fields.map(([key, heading]) => ({
      heading, markdown:data.sections[key],
      evidence:document.querySelector('#doc-section-' + key + ' .section-sources')?.cloneNode(true)
    }));
    const currentId = doc.id;
    button.disabled = true;
    button.textContent = 'Подготовка PDF…';
    try {
      const {downloadDocument} = await import('/document-pdf.js');
      await downloadDocument(data.title.trim() || 'Дизайн-документ', sections);
    } catch {
      if (doc?.id === currentId) error('Не удалось скачать PDF. Повторите попытку.');
    } finally {
      button.disabled = false;
      button.textContent = 'Скачать PDF';
    }
  };
  const closePreview=()=>{if(!$('publish-confirm').disabled)$('publish-dialog').close();};$('preview-close').onclick=closePreview;$('publish-cancel').onclick=closePreview;
  $('publish-dialog').addEventListener('cancel',e=>{if($('publish-confirm').disabled)e.preventDefault();});
  $('publish-confirm').onclick=async()=>{const button=$('publish-confirm');if(button.disabled)return;button.disabled=true;error('','publish-error');try{const r=await api('publish',{id:doc.id,revision:preview.revision,digest:preview.digest});$('publish-dialog').close();await openRelease(r.release_id);message('Документ опубликован в каталоге сообщества.');}catch(e){error(e.message,$('publish-dialog').open?'publish-error':'editor-error');}finally{button.disabled=false;}};
  window.addEventListener('beforeunload',e=>{if(dirty){cache();e.preventDefault();e.returnValue='';}});
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'&&doc){e.preventDefault();task(save);}});
  async function start(){const session=await api('session',{},true);account=session.user;$('register').hidden=session.registration_open===false||!session.enabled;if(!account){$('auth').hidden=false;return;}$('account').textContent='На этом компьютере';
    if(query.has('release'))await openRelease(query.get('release'));else if(query.has('id')){await open(query.get('doc') || query.get('id'));}else if(query.has('new')){
      const links = {};
      for (const [param,key] of [['tree','tree_id'],['metric','metric_tree_id']]) {
        const id = query.get(param);
        if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) links[key] = id;
      }
      const draftId = query.get('doc') || query.get('new');
      if (/^[a-f0-9-]{36}$/.test(draftId)) {
        // Another visit to step four may already have saved this task.
        try { await open(draftId); return; }
        catch (error) { if (error.status !== 404) throw error; }
        await create(draftId, links);
      } else await create(undefined, links);
    }else await list(query.get('view')==='catalog'?'catalog':'mine');}
  async function login(register){try{await api(register?'register':'login',{username:$('username').value,password:$('password').value},true);$('password').value='';await start();}catch(e){message(e.message);}}
  $('login-form').onsubmit=e=>{e.preventDefault();login(false);};$('register').onclick=()=>{if($('login-form').reportValidity())login(true);};
  window.addEventListener('pageshow', event => {
    if (event.persisted && account && mode === 'mine' && !$('list').hidden) task(() => list('mine'));
  });
  start().catch(e=>{message(e.message);if(account){$('list').hidden=false;$('documents').append(node('p','Можно открыть свои документы или создать новый.','muted'));}});
})();

