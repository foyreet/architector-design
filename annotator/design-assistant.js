'use strict';
window.setupDesignAssistant = function ({fields, api, read, changed, getId, linksChanged}) {
  const $ = id => document.getElementById(id);
  const dialog = $('design-assist-dialog');
  let refs = {}, links = {}, token = 0;
  function el(tag, text) {
    const item = document.createElement(tag);
    item.textContent = text;
    return item;
  }
  let unavailable = new Set();
  function sourceLink(text, step, id, version, caseId) {
    const expected = step === 'metrics' ? links.metric_tree_id : links.tree_id;
    if (id !== expected || unavailable.has(step + '/' + id)) {
      return el('span', text + ' · Исторический источник');
    }
    const href = window.designFlow.url(step);
    if (caseId) {
      href.searchParams.set('version', version);
      href.hash = 'case-' + caseId;
    }
    const item = el('a', text);
    item.href = href;
    item.target = '_blank';
    item.rel = 'noopener';
    return item;
  }
  function evidence(ref) {
    const box = el('details', '');
    box.append(el('summary', 'Источники раздела'));
    if (ref.tree_id) box.append(sourceLink(ref.title + ' · версия ' + ref.revision, 'problems', ref.tree_id));
    for (const a of ref.answers || []) box.append(el('p', a.path.join(' → ') + ' — ' + a.answer));
    for (const c of ref.cases || []) {
      box.append(el('p', 'Кейс из версии ' + ref.version + ' · '),
        sourceLink(c.title, 'solutions', ref.tree_id, ref.version, c.id));
    }
    const tree = ref.metric_tree;
    if (tree) {
      box.append(el('p', 'Иерархия метрик'), sourceLink(tree.title + ' · версия ' + tree.revision, 'metrics', tree.id));
      if (tree.goal) box.append(el('p', 'Бизнес-цель: ' + tree.goal));
      for (const node of tree.nodes) {
        const details = el('details', '');
        details.append(el('summary', node.path.join(' → ')));
        for (const [key, label] of Object.entries({role:'Роль', definition:'Определение', unit:'Единица',
          direction:'Направление', measurement:'Измерение', relation:'Связь с родителем', check:'Проверка связи'})) {
          if (node[key]) details.append(el('p', label + ': ' + node[key]));
        }
        box.append(details);
      }
    }
    return box;
  }
  function showRefs() {
    document.querySelectorAll('.section-sources').forEach(box => box.remove());
    for (const [key, ref] of Object.entries(refs)) {
      const input = $('section-' + (key === 'data_features' ? 'dataset' : key));
      if (!input) continue;
      const box = evidence(ref);
      box.className = 'section-sources';
      input.after(box);
    }
  }
  async function checkUpdates() {
    const documentId = getId(), current = refs;
    if (!documentId) return;
    const versions = new Map();
    function latest(endpoint, id) {
      const key = endpoint + '/' + id;
      if (!versions.has(key)) versions.set(key, api('get', {...window.designFlow.aiScope(), id}, endpoint).catch(() => null));
      return versions.get(key);
    }
    const stale = [], missing = new Set();
    for (const [key, label] of fields) {
      const ref = current[key];
      if (!ref) continue;
      const [state, metric] = await Promise.all([
        ref.tree_id && ref.tree_id === links.tree_id && latest('solution-spaces', ref.tree_id),
        ref.metric_tree && ref.metric_tree.id === links.metric_tree_id && latest('metric-trees', ref.metric_tree.id)
      ]);
      if (documentId !== getId() || current !== refs) return;
      if (ref.tree_id && !state) {
        missing.add('problems/' + ref.tree_id);
        missing.add('solutions/' + ref.tree_id);
      }
      if (ref.metric_tree && !metric) missing.add('metrics/' + ref.metric_tree.id);
      const treeChanged = state && state.source.revision !== ref.revision &&
        (!ref.answers.length || ref.problem !== state.source.problem || ref.title !== state.source.title ||
         ref.answers.some(a => !state.source.answers.some(b => b.answer === a.answer && JSON.stringify(b.path) === JSON.stringify(a.path))));
      if ((ref.tree_id && (!state || treeChanged || (ref.cases.length && state.version !== ref.version))) ||
          (ref.metric_tree && metric?.revision !== ref.metric_tree.revision)) stale.push(label);
    }
    if (documentId !== getId() || current !== refs) return;
    if (missing.size !== unavailable.size || [...missing].some(key => !unavailable.has(key))) {
      unavailable = missing;
      showRefs();
    }
    $('source-update').textContent = stale.length ? 'Проверьте источники разделов: ' + stale.join(', ') + '. Можно собрать новый черновик.' : '';
  }
  window.addEventListener('focus', checkUpdates);
  function status(text) { $('assist-status').textContent = text; }
  function open(title) {
    token++;
    $('assist-heading').textContent = title;
    $('assist-content').replaceChildren();
    $('assist-footer').replaceChildren();
    status('');
    dialog.showModal();
    return token;
  }
  function action(text, run) {
    const button = el('button', text);
    $('assist-footer').append(button);
    button.onclick = async () => {
      const active = token;
      button.disabled = true;
      try { await run(); }
      catch (error) { if (active === token) status(error.message); }
      finally { if (active === token) button.disabled = false; }
    };
    return button;
  }
  function check(text, checked) {
    const label = el('label', '');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    label.append(input, document.createTextNode(text));
    return {label, input};
  }
  function preview(proposals, initial, selectedLinks) {
    const content = $('assist-content'), choices = [];
    content.replaceChildren();
    $('assist-footer').replaceChildren();
    $('assist-heading').textContent = 'Предпросмотр черновика';
    status('Выберите разделы для применения. Заполненные разделы можно заменить по отдельности.');
    for (const [key, name] of fields) {
      const proposal = proposals[key];
      if (!proposal) continue;
      const section = el('section', ''), choice = check(name, !initial.sections[key].trim());
      choices.push([key, choice.input, proposal]);
      section.append(choice.label);
      if (initial.sections[key]) {
        section.append(el('strong', 'Сейчас в документе'), window.ChatMarkdown(initial.sections[key]));
      }
      section.append(el('strong', 'Предложение'), window.ChatMarkdown(proposal.text));
      if (Object.keys(proposal.source).length) section.append(evidence(proposal.source));
      content.append(section);
    }
    action('Применить выбранные разделы', () => {
      const selected = choices.filter(([, input]) => input.checked);
      if (!selected.length) return status('Отметьте хотя бы один раздел.');
      if (selected.some(([key]) => $('section-' + key).value !== initial.sections[key])) {
        return status('Текст изменился после запроса. Откройте новый предпросмотр.');
      }
      refs = {...refs};
      for (const [key, , proposal] of selected) {
        $('section-' + key).value = proposal.text;
        if (Object.keys(proposal.source).length) refs[key] = proposal.source;
        else delete refs[key];
      }
      links = selectedLinks; linksChanged(links);
      showRefs(); changed(); dialog.close(); checkUpdates();
    });
    content.scrollIntoView({block:'start'});
  }
  async function compose() {
    const active = open('Собрать черновик');
    status('Загружаем материалы задачи…');
    const {problem, metric} = await api('task-sources');
    if (token !== active) return;
    const content = $('assist-content');
    const label = el('label', 'Что нужно отразить в черновике?');
    const brief = document.createElement('textarea');
    brief.rows = 2; label.append(brief); content.append(label);
    if (problem) content.append(el('p', 'Дерево проблем: ' + problem.title));
    if (metric) content.append(el('p', 'Иерархия метрик: ' + metric.title));
    if (problem?.shared || metric?.shared) {
      content.append(el('p', 'Среди источников есть дерево, ранее связанное с несколькими задачами. Изменения этого дерева видны во всех этих задачах.'));
    }
    const options = [];
    if (problem?.cases.length) {
      const cases = el('fieldset', '');
      cases.append(el('legend', 'Кейсы для черновика'));
      const chosen = links.tree_id === problem.id && Array.isArray(links.cases);
      for (const [index, title] of problem.cases.entries()) {
        const choice = check(title, !chosen || (links.case_version === problem.version && links.cases.includes(index + 1)));
        cases.append(choice.label); options.push(choice.input);
      }
      if (chosen && links.case_version !== problem.version) cases.append(el('p', 'Версия кейсов изменилась. Выберите нужные кейсы заново.'));
      content.append(cases);
    }
    status(problem || metric ? '' : 'Можно начать с описания задачи или текущего текста документа.');
    action('Подготовить предложение', async () => {
      const initial = read();
      const selected = options.flatMap((input, i) => input.checked ? [i + 1] : []);
      const selectedLinks = {...links};
      if (problem) Object.assign(selectedLinks, {tree_id:problem.id, cases:selected, case_version:problem.version});
      if (metric) selectedLinks.metric_tree_id = metric.id;
      status('Модель готовит черновик…');
      const data = await api('compose', {...initial, request:brief.value, tree_id:problem?.id,
        revision:problem?.revision, version:problem?.version, cases:selected,
        metric_tree_id:metric?.id, metric_revision:metric?.revision});
      if (token === active) preview(data.proposals, initial, selectedLinks);
    });
  }
  async function review() {
    const active = open('Ревью документа'), draft = read();
    if (!Object.values(draft.sections).some(s => s.trim())) return status('Чтобы провести ревью, заполните хотя бы один раздел.');
    status('Модель читает текущий текст…');
    const {comments} = await api('review', draft);
    if (token !== active) return;
    status(comments.length ? 'Вопросы к текущей версии документа' : 'У модели нет вопросов к этому черновику.');
    for (const comment of comments) {
      const section = el('section', '');
      section.append(el('h3', fields.find(([key]) => key === comment.section)[1]), el('blockquote', comment.quote),
        el('p', comment.reason), el('strong', comment.question));
      $('assist-content').append(section);
    }
  }
  function launch(fn) {
    const pending = fn(), active = token;
    pending.catch(error => { if (active === token) status(error.message); });
  }
  $('compose-doc').onclick = () => launch(compose);
  $('review-doc').onclick = () => launch(review);
  $('assist-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { token++; });
  return {
    sources: () => refs,
    taskLinks: () => links,
    load(value, taskLinks) {
      links = taskLinks || {};
      refs = value || {};
      unavailable = new Set();
      $('source-update').textContent = '';
      showRefs(); checkUpdates();
    }
  };
};
