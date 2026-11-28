'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let id = params.get('id');
  function page(path, treeId) {
    const url = new URL(path, location.origin);
    if (params.has('project')) url.searchParams.set('project', params.get('project'));
    if ((!treeId || !params.get('tree') || treeId === params.get('tree'))) {
      for (const key of ['tree', 'metric', 'doc', 'draft']) {
        if (params.has(key)) url.searchParams.set(key, params.get(key));
      }
    }
    if (treeId) url.searchParams.set('id', treeId);
    return url;
  }
  const labels = {title:'Кейс', validation:'Критерий готовности', rationale:'Почему это нужно', approach:'Возможный подход',
    tradeoffs:'Ограничения и компромиссы', assumptions:'Предположения', business_query:'Запрос по бизнес-задаче', query:'Запрос по технической задаче'};
  const status = text => { $('status').textContent = text; };
  // Messages about building cases stay next to the button that starts it.
  const generateNote = text => { $('generate-status').textContent = text; };
  let source, working, proposal, version, dirty = false, generation = 0, busy = false;
  const newCases = new Set();
  let savedPlan;
  function element(tag, text) {
    const item = document.createElement(tag);
    item.textContent = text;
    return item;
  }
  async function api(action, data = {}, resource = 'solution-spaces') {
    const response = await fetch('/api/' + resource + '/' + action, {method:'POST',
      headers:{'Content-Type':'application/json','X-Architect-Request':'1'}, body: JSON.stringify({...window.designFlow.aiScope(), id, ...data})});
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.error || 'Ошибка запроса'), {status: response.status});
    return result;
  }
  window.setupMethodEditor({
    first:'cases',
    load:() => api('method'),
    save:changes => api('save-method', {changes})
  });
  function controls() {
    $('add-case').disabled = $('generate').disabled = busy || !source;
    $('apply').disabled = busy || !proposal || !$('proposals').querySelector('input:checked');
    // Once cases exist, regeneration is a secondary action and saving becomes the primary one.
    $('generate').classList.toggle('primary', !working);
    $('save').hidden = !working;
    $('save').disabled = busy || !dirty;
    $('workspace').inert = busy;
    $('stale').textContent = working && source.revision !== working.source.revision ?
      'Дерево изменилось после подготовки кейсов. Можно запросить новые предложения.' : '';
  }
  function mark() { dirty = true; controls(); }
  function showSources(box, items) {
    box.replaceChildren();
    for (const item of items || []) {
      const block = document.createElement('section');
      const link = element('a', item.title);
      link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      block.append(link, element('small', item.provider + ' · ' + item.outcome));
      for (const [name, text] of [['Бизнесовое сходство',item.business],['Техническое сходство',item.technical],['Что можно применить',item.reuse]]) {
        block.append(element('strong', name), element('p', text));
      }
      if (item.quote) block.append(element('blockquote',item.quote));
      box.append(block);
    }
  }
  const searchKeys = ['business_query', 'query'];
  function cards(container, plan, editable) {
    container.replaceChildren();
    for (const item of plan.options) {
      const card = document.createElement('article');
      const number = container.children.length + 1;
      if (editable) card.id = 'case-' + number;
      const search = document.createElement('section');
      search.className = 'case-search';
      search.append(element('h4', 'Поиск аналогов'));
      for (const [key, label] of Object.entries(labels)) {
        if (!editable) {
          if (key === 'title') {
            const heading = document.createElement('h3');
            const choice = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.value = String(number - 1);
            choice.append(checkbox, element('span', item.title));
            heading.append(choice);
            card.append(heading);
          } else if (item[key]) {
            card.append(element('strong', label), element('p', item[key]));
          }
          continue;
        }
        const field = element('label', label), input = document.createElement('textarea');
        if (key === 'title') {
          const name = element('span', label + ' ' + number), badge = element('span', String(number));
          name.className = 'visually-hidden';
          badge.className = 'step-number';
          badge.setAttribute('aria-hidden', 'true');
          field.className = 'case-title';
          field.replaceChildren(name, badge);
          input.rows = 1;
        } else input.rows = ['approach','rationale','tradeoffs'].includes(key) ? 3 : 2;
        input.value = item[key];
        input.placeholder = key === 'title' ? 'Название кейса' : 'Не заполнено';
        input.required = key === 'title';
        input.oninput = () => { item[key] = input.value; mark(); };
        field.append(input);
        (searchKeys.includes(key) ? search : card).append(field);
      }
      const refs = document.createElement('details');
      refs.append(element('summary','На каких ответах основан кейс'));
      for (const i of item.evidence) {
        const a = plan.source.answers[i - 1];
        refs.append(element('strong',a.path.join(' → ')), element('p', a.answer));
      }
      if (item.evidence.length) card.append(refs);
      if (editable) {
        const find = element('button','Найти аналоги в интернете'), note = element('p','');
        const sources = document.createElement('div'); sources.className = 'sources';
        note.className = 'search-note';
        note.setAttribute('role','status');
        find.onclick = async () => {
          busy = true; controls(); note.textContent = 'Ищем внедрения, разборы неудач, статьи и реализации…';
          try {
            const data = await api('research', {case:item, request:plan.request || '', source_revision:plan.source.revision});
            if (data.sources.length) {
              const byUrl = new Map((item.sources || []).map(s => [s.url,s]));
              data.sources.forEach(s => byUrl.set(s.url,s));
              item.sources = [...byUrl.values()]; showSources(sources,item.sources); mark();
            }
            note.textContent = (data.sources.length ? 'Найдено источников: ' + data.sources.length : 'Подходящих источников не найдено.') +
              (data.unavailable.length ? ' Недоступны: ' + data.unavailable.join(', ') : '');
          } catch (e) { note.textContent = e.message; }
          finally { busy = false; controls(); }
        };
        const hint = element('p','Для поиска заполните оба запроса. Они будут отправлены в поисковые сервисы.');
        const searchReady = () => { find.disabled = ![item.title, item.business_query, item.query].every(value => value.trim()); };
        card.addEventListener('input', searchReady);
        searchReady();
        hint.className = 'search-hint';
        search.append(hint, find, note, sources);
        card.append(search);
        showSources(sources,item.sources);
        if (newCases.has(item)) {
          const cancel = element('button', 'Отменить добавление');
          cancel.onclick = () => {
            newCases.delete(item);
            working.options.splice(working.options.indexOf(item), 1);
            if (!working.options.length) working = null;
            dirty = JSON.stringify(working) !== savedPlan;
            renderCases();
            status(dirty ? 'Есть несохранённые изменения.' : 'Добавление отменено.');
            $('add-case').focus();
          };
          card.append(cancel);
        }
      }
      container.append(card);
    }
  }
  function renderCases() {
    $('workspace').hidden = !working;
    if (working) cards($('options'), working, true);
    else $('options').replaceChildren();
    controls();
  }
  $('add-case').onclick = () => {
    if (!working) working = {source, request:$('case-request').value, options:[]};
    const item = Object.fromEntries(Object.keys(labels).map(key => [key, '']));
    item.evidence = [];
    working.options.push(item);
    newCases.add(item);
    dirty = true;
    renderCases();
    status('Введите название и сохраните кейсы.');
    $('options').lastElementChild.querySelector('.case-title textarea').focus();
  };
  function hidePreview() {
    generation++; proposal = null; busy = false;
    $('preview').hidden = $('cancel').hidden = true; controls();
  }
  $('generate').onclick = async () => {
    hidePreview();
    const token = generation;
    busy = true; controls(); $('cancel').hidden = false;
    generateNote('Модель разбирает ответы на кейсы…');
    try {
      const result = await api('generate', {request:$('case-request').value});
      if (token !== generation) return;
      proposal = result; cards($('proposals'), proposal, false); $('preview').hidden = false;
      generateNote(working ? 'Принятые предложения заменят текущие кейсы. Сохранение отдельной кнопкой.' : 'Проверьте кейсы и их связь с запросом и материалами задачи.');
    } catch (e) { if (token === generation) generateNote(e.message); }
    finally { if (token === generation) { busy = false; $('cancel').hidden = true; controls(); } }
  };
  $('cancel').onclick = $('discard').onclick = () => { hidePreview(); generateNote('Предложение отменено.'); };
  $('proposals').onchange = controls;
  $('apply').onclick = () => {
    if (!proposal || busy) return;
    const selected = Array.from($('proposals').querySelectorAll('input:checked'), input => proposal.options[Number(input.value)]);
    if (!selected.length) return;
    if (working && !confirm('Заменить текущие кейсы и их подборки источников выбранными кейсами?')) return;
    newCases.clear();
    working = {...proposal, options:selected}; source = proposal.source; hidePreview(); cards($('options'), working, true);
    $('workspace').hidden = false; generateNote('Кейсы приняты. Можно искать аналоги и сохранять изменения.'); mark();
  };
  $('save').onclick = async () => {
    const missing = [...$('options').querySelectorAll('.case-title textarea')].find(field => !field.value.trim());
    if (missing) {
      status('Введите название кейса.');
      missing.focus();
      return;
    }
    busy = true; controls();
    try {
      const result = await api('save', {version, source_revision:working.source.revision, options:working.options, request:working.request || ''});
      if (pendingTree) {
        pendingTree = false;
        window.designFlow.treeOpened('tree', id, true);
        window.designFlow.remember('solutions');
        history.replaceState(null, '', window.designFlow.url('solutions'));
        $('library').hidden = true;
      }
      version = result.version;
      savedPlan = JSON.stringify(working);
      newCases.clear();
      dirty = false;
      renderCases();
      status('Кейсы сохранены.');
    } catch (e) { status(e.message); }
    finally { busy = false; controls(); }
  };
  window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
  async function start() {
    const data = await api('get');
    if (!id && !data.pending_tree) {
      window.designFlow.treeOpened('tree', data.id, true);
      history.replaceState(null, '', window.designFlow.url('solutions'));
    }
    id = data.id;
    window.designFlow.remember('solutions');
    $('editor').hidden = false;
    pendingTree = data.pending_tree; source = data.source; version = data.version; working = data.saved;
    savedPlan = JSON.stringify(working);
    $('title').textContent = taskTitle || source.title; $('problem').textContent = source.problem;
    for (const a of source.answers) $('answers').append(element('strong', a.path.join(' → ')),element('p', a.answer));
    if (data.shared) status('Это дерево уже связано с несколькими задачами. Изменения кейсов видны в каждой из них.');
    if (working) { cards($('options'), working, true); $('workspace').hidden = false; }
    $('case-request').value = working?.request || '';
    $('context').hidden = !source.answers.length;
    controls();
    if (/^#case-\d+$/.test(location.hash)) {
      if (params.has('version') && String(version) !== params.get('version')) status('Подборка кейсов изменилась. Открыта текущая версия.');
      else document.getElementById(location.hash.slice(1))?.scrollIntoView();
    }
  }
  async function library() {
    $('library').hidden = false;
    status('Загрузка деревьев…');
    const {trees} = await api('list');
    status('');
    const list = $('tree-list');
    window.designFlow.remember('solutions');
    if (!trees.length) {
      const create = element('a', 'Создать дерево проблем');
      create.href = '/problem-space.html?new=1';
      list.append(element('p', 'Пока нет сохранённых деревьев.'), create);
    }
    for (const tree of trees) {
      const link = element('a', '');
      link.className = 'document-row';
      link.href = page('/solution-space.html', tree.id);
      link.append(element('strong', tree.title), element('small', tree.has_cases ? 'Есть сохранённые кейсы' : 'Кейсы ещё не созданы'));
      list.append(link);
    }
  }
  // A step link may point at a tree that exists only as an unsaved draft: offer the saved ones instead.
  async function fallback(error) {
    if (error.status !== 404 || params.has('doc')) throw error;
    await library();
    status('Это дерево ещё не сохранено. Выберите сохранённое дерево или вернитесь к вопросам.');
  }
  let taskTitle, pendingTree;
  async function openStage() {
    const task = await window.designFlow.resolveTask();
    if (task) {
      taskTitle = task.title;
      id = task.links.tree_id;
      const current = window.designFlow.url('solutions');
      if (params.has('version') && params.get('id') === id) current.searchParams.set('version', params.get('version'));
      if (params.get('id') === id) current.hash = location.hash;
      history.replaceState(null, '', current);
    }
    if (taskTitle) {
      $('title').textContent = taskTitle;
      document.title = taskTitle + ' · ' + document.title;
    }
    if (id || params.has('doc')) await start().catch(fallback);
    else await library();
  }
  openStage().catch(e => status(e.message));
})();
