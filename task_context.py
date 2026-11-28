"""Current saved materials of the task selected in this tab."""
import json

from block_contracts import ContractError
from design_documents import identity, standalone_id


def linked_tasks(db, owner, key, tree_id):
    return db.execute(f'''SELECT id FROM design_documents WHERE owner=? AND json_extract(task_links, '$.{key}')=?
                          UNION SELECT id FROM design_task_drafts WHERE owner=? AND {key}=? LIMIT 2''',
                      (owner, tree_id, owner, tree_id)).fetchall()


def task_record(db, owner, body):
    task_id = body.get('task_id')
    if not task_id:
        # Direct tree URLs carry no task ID. Reuse a task only when the tree
        # identifies it unambiguously, including data created before named tasks.
        anchors = [(kind, key, body.get('task_' + key)) for kind, key in
                   [('problem', 'tree_id'), ('metric', 'metric_tree_id')] if body.get('task_' + key)]
        if len(anchors) != 1:
            return None, {}, {}
        _, key, anchor = anchors[0]
        identity(anchor)
        matches = linked_tasks(db, owner, key, anchor)
        if len(matches) != 1:
            return None, {key:anchor}, {}
        task_id = matches[0]['id']
    task_id = identity(task_id)
    row = db.execute('SELECT title,task_links,sections FROM design_documents WHERE owner=? AND id=?',
                     (owner, task_id)).fetchone()
    if row:
        return row['title'], json.loads(row['task_links']), json.loads(row['sections'])
    draft = db.execute('SELECT title,tree_id,metric_tree_id FROM design_task_drafts WHERE owner=? AND id=?',
                       (owner, task_id)).fetchone()
    if draft:
        return draft['title'], dict(draft), {}
    # Older unlinked trees have a deterministic task ID until their next save.
    for kind, key in [('problem', 'tree_id'), ('metric', 'metric_tree_id')]:
        anchor = body.get('task_' + key)
        if (anchor and standalone_id(owner, kind, identity(anchor)) == task_id
                and not used_by_other_task(db, owner, task_id, key, anchor)):
            return None, {key: anchor}, {}
    return None, {}, {}


def used_by_other_task(db, owner, task_id, key, tree_id):
    return bool(db.execute(f'''SELECT 1 FROM design_documents
                               WHERE owner=? AND id<>? AND json_extract(task_links, '$.{key}')=?
                               UNION ALL SELECT 1 FROM design_task_drafts
                               WHERE owner=? AND id<>? AND {key}=? LIMIT 1''',
                           (owner, task_id, tree_id, owner, task_id, tree_id)).fetchone())


def navigation(hub, user, body):
    owner = user['id']
    task_id = body.get('task_id')
    with hub.db() as db:
        db.execute('BEGIN')
        if not task_id:
            # Older standalone stage links carry the tree, without a document ID.
            for kind, key in [('problem', 'tree_id'), ('metric', 'metric_tree_id')]:
                anchor = body.get('task_' + key)
                if not anchor:
                    continue
                identity(anchor)
                rows = linked_tasks(db, owner, key, anchor)
                if len(rows) > 1:
                    raise ContractError('Это дерево используется в нескольких задачах. Откройте нужную задачу из списка.', 409)
                task_id = rows[0]['id'] if rows else standalone_id(owner, kind, anchor)
                break
        identity(task_id)
        title, links, sections = task_record(db, owner, {**body, 'task_id':task_id})
        stages = {k: links[k] for k in ('tree_id', 'metric_tree_id') if links.get(k)}
        if not title:
            for key, table in [('tree_id', 'problem_spaces'), ('metric_tree_id', 'metric_trees')]:
                if key in stages:
                    row = db.execute(f'SELECT title FROM {table} WHERE owner=? AND id=?',
                                     (owner, stages[key])).fetchone()
                    if row:
                        title = row['title']
                        break
        return {'id': task_id, 'title': title, 'links': stages, 'draft': not bool(sections)}


def case_with_answers(case, source):
    result = dict(case)
    previous = result.pop('previous_evidence', None)
    if previous:
        result.update(evidence=previous['answers'], evidence_revision=previous['revision'])
    else:
        result.update(evidence=[source['answers'][i - 1] for i in case['evidence']], evidence_revision=source['revision'])
    return result


def composition_sources(hub, user, body):
    task_id = identity(body.get('task_id'))
    owner = user['id']
    with hub.db() as db:
        db.execute('BEGIN')
        _, links, _ = task_record(db, owner, body)
        result = {'problem': None, 'metric': None}
        tree_id = links.get('tree_id')
        if tree_id:
            row = db.execute('''SELECT p.title,p.revision,s.version,s.content FROM problem_spaces p
                                LEFT JOIN solution_spaces s ON s.tree_id=p.id WHERE p.owner=? AND p.id=?''',
                             (owner, tree_id)).fetchone()
            if row:
                cases = json.loads(row['content'])['options'] if row['content'] else []
                result['problem'] = {'id':tree_id, 'title':row['title'], 'revision':row['revision'],
                                     'version':row['version'] or 0, 'cases':[c['title'] for c in cases],
                                     'shared':used_by_other_task(db, owner, task_id, 'tree_id', tree_id)}
        metric_id = links.get('metric_tree_id')
        if metric_id:
            row = db.execute('SELECT id,title,revision FROM metric_trees WHERE owner=? AND id=?',
                             (owner, metric_id)).fetchone()
            if row:
                result['metric'] = dict(row, shared=used_by_other_task(db, owner, task_id, 'metric_tree_id', metric_id))
        return result


def saved_materials(hub, user, body, stage):
    owner = user['id']
    with hub.db() as db:
        db.execute('BEGIN')
        title, links, sections = task_record(db, owner, body)
        result = {'title': title} if title else {}
        problem_id, metric_id = links.get('tree_id'), links.get('metric_tree_id')
        # Respect explicit source selection in the document composition dialog.
        if stage == 'compose':
            if body.get('tree_id') != problem_id:
                problem_id = None
            metric_id = None  # The selected hierarchy is already in the composition payload.
        if problem_id:
            tree = db.execute('SELECT problem,tree FROM problem_spaces WHERE id=? AND owner=?',
                              (problem_id, owner)).fetchone()
            if tree and stage != 'problems':
                result['problems'] = {'formulation': tree['problem'], 'questions': json.loads(tree['tree'])}
            if tree and stage != 'compose':
                row = db.execute('SELECT content,version FROM solution_spaces WHERE tree_id=?', (problem_id,)).fetchone()
                if row:
                    plan = json.loads(row['content'])
                    selected = links.get('cases')
                    options = []
                    for index, case in enumerate(plan['options'], 1):
                        if selected is not None and (row['version'] != links.get('case_version') or index not in selected):
                            continue
                        options.append(case_with_answers(case, plan['source']))
                    result['solutions'] = {'saved_cases': options, 'request': plan.get('request', '')}
        if metric_id and stage != 'metrics':
            tree = db.execute('SELECT problem,tree FROM metric_trees WHERE id=? AND owner=?',
                              (metric_id, owner)).fetchone()
            if tree:
                result['metrics'] = {'goal': tree['problem'], 'nodes': json.loads(tree['tree'])}
        if stage not in ('compose', 'review'):
            filled = {key: text for key, text in sections.items() if text.strip()}
            if filled:
                result['document'] = filled
        return result


def request_text(body):
    text = body.get('request', '')
    if not isinstance(text, str):
        raise ContractError('Введите текст запроса.')
    return text.strip()
