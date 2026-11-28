import json
import tempfile
import unittest
import uuid
from unittest.mock import patch

import design_assistant
import design_documents
import metric_trees
import problem_spaces
import solution_spaces
from block_contracts import ContractError
from local_workspace import Community, LOCAL_USER


def uid():
    return str(uuid.uuid4())


class ContextTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.hub = Community(folder.name)
        self.task, self.tree, self.metric = uid(), uid(), uid()
        self.call(design_documents, 'create-task', id=self.task, title='Продление')
        self.case = {key:'Кейс подписки' for key in solution_spaces.FIELDS} | {'evidence':[]}
        self.sections = dict.fromkeys(design_documents.SECTIONS, '') | {'problem':'Черновик про подписку'}
        self.node = dict.fromkeys(metric_trees.FIELDS, '') | {'name':'Маржа', 'children':[]}

    def call(self, module, action, **body):
        return module.request(self.hub, LOCAL_USER, body, action)

    def test_start_with_solutions_then_use_all_four_stages(self):
        scope = {'task_id':self.task, 'id':self.tree}
        brief = 'Сравнить скидки на продление'
        with patch('solution_spaces.standalone_answer', return_value=json.dumps([self.case])):
            self.call(solution_spaces, 'generate', **scope, request=brief)
        self.assertFalse(self.call(problem_spaces, 'list')['trees'])
        save = dict(scope, options=[self.case], version=0, source_revision=1, request=brief)
        self.assertEqual(self.call(solution_spaces, 'save', **save), self.call(solution_spaces, 'save', **save))
        self.call(problem_spaces, 'save', id=self.tree, revision=1, title='Продление', problem='Отток',
                  problem_tree=[{'question':'Бюджет?', 'answer':'Лимит на скидки', 'children':[]}])
        self.call(metric_trees, 'save', id=self.metric, title='Метрики', draft_task=self.task,
                  goal='Выручка', metrics=[self.node], revision=0)
        self.call(design_documents, 'create', id=self.task, title='Продление', sections=self.sections)
        other = uid()
        self.call(design_documents, 'create', id=other, title='Другая задача',
                  sections={**self.sections,'problem':'ЧУЖОЙ ТЕКСТ'})
        with patch('metric_trees.standalone_answer', return_value=json.dumps([self.node])) as model:
            self.call(metric_trees, 'suggest', task_id=self.task, title='Продление', goal='Новая цель',
                      metrics=[], request='Какая метрика?', path=[])
        data = json.loads(model.call_args.args[1])
        ctx = data['task_context']
        self.assertEqual(ctx['problems']['questions'][0]['answer'], 'Лимит на скидки')
        self.assertEqual(ctx['solutions']['request'], brief)
        self.assertEqual(ctx['solutions']['saved_cases'][0]['title'], self.case['title'])
        self.assertEqual(ctx['document']['problem'], self.sections['problem'])
        self.assertEqual(data['goal'], 'Новая цель')
        self.assertNotIn('ЧУЖОЙ ТЕКСТ', str(data))

        with patch('metric_trees.standalone_answer', return_value=json.dumps([self.node])) as model:
            self.call(metric_trees, 'suggest', task_metric_tree_id=self.metric, title='Продление',
                      goal='Выручка', metrics=[], request='Уточни', path=[])
        self.assertEqual(json.loads(model.call_args.args[1])['task_context']['title'], 'Продление')

        with patch('codex_chat.standalone_answer', return_value='[{"question":"Q?", "children":[]}]') as model:
            self.call(problem_spaces, 'suggest-questions', task_id=self.task, title='Продление',
                      problem='Отток', problem_tree=[], path=[], request='Уточни')
        self.assertEqual(json.loads(model.call_args.args[1])['task_context']['metrics']['nodes'][0], self.node)
        with patch('design_assistant.standalone_answer', return_value='[]') as model:
            self.call(design_assistant, 'review', task_id=self.task, title='Продление', sections=self.sections)
        self.assertEqual(json.loads(model.call_args.args[1])['task_context']['metrics']['goal'], 'Выручка')
        with patch('solution_spaces.standalone_answer', return_value='[]') as model, patch('solution_spaces.search', return_value=([{'id':1}], [])) as web:
            self.call(solution_spaces, 'research', **scope, case=self.case, source_revision=1)
        web.assert_called_once_with(self.case['business_query'], self.case['query'])
        self.assertEqual(json.loads(model.call_args.args[1])['context']['task_context']['metrics']['goal'], 'Выручка')

    def test_document_first_and_scope_isolation(self):
        result = {'problem': {'text':'Предложение', 'answers':[], 'cases':[]}}
        with patch('design_assistant.standalone_answer', return_value=json.dumps(result)) as model:
            self.call(design_assistant, 'compose', task_id=self.task, request='Описать цену ошибки',
                      sections=dict.fromkeys(self.sections, ''), title='Продление')
        self.assertEqual(json.loads(model.call_args.args[1])['request'], 'Описать цену ошибки')
        self.assertFalse(self.call(design_documents, 'list')['documents'])
        with self.assertRaises(ContractError):
            solution_spaces.request(self.hub, {'id':'other'}, {'id':self.tree,'task_id':self.task}, 'get')

    def test_only_linked_materials_available_to_task(self):
        other = uid()
        self.call(design_documents, 'create-task', id=other, title='Другая задача')
        self.call(solution_spaces, 'save', task_id=self.task, id=self.tree, version=0,
                  source_revision=1, request='Подписка', options=[self.case])
        self.call(metric_trees, 'save', id=self.metric, title='Маржа', draft_task=self.task,
                  goal='Рост', metrics=[self.node], revision=0)
        own = self.call(design_documents, 'task-sources', task_id=self.task)
        self.assertEqual(own['problem']['cases'], [self.case['title']])
        self.assertFalse(own['problem']['shared'])
        self.assertEqual(own['metric']['id'], self.metric)
        self.assertEqual(self.call(solution_spaces, 'get', task_id=self.task)['id'], self.tree)
        self.assertEqual(self.call(design_documents, 'task-sources', task_id=other, task_tree_id=self.tree),
                         {'problem':None, 'metric':None})
        blank = self.call(solution_spaces, 'get', task_id=other)
        self.assertTrue(blank['pending_tree'])
        self.assertIsNone(blank['saved'])
        with self.assertRaises(ContractError):
            self.call(solution_spaces, 'get', id=self.tree, task_id=other)
        with self.assertRaises(ContractError):
            self.call(problem_spaces, 'attach', id=self.tree, draft_task=other)
        for key, value in [('tree_id', self.tree), ('metric_tree_id', self.metric)]:
            with self.subTest(key=key), self.assertRaises(ContractError), patch('design_assistant.standalone_answer') as model:
                self.call(design_assistant, 'compose', title='Другая задача', task_id=other,
                          sections=self.sections, **{key:value})
            model.assert_not_called()
        # A pre-existing shared reference is reported without rewriting either task.
        with self.assertRaises(ContractError):
            self.call(design_documents, 'create', id=uid(), title='Другой документ', sections=self.sections,
                      task_links={'tree_id':self.tree})
        legacy = self.call(design_documents, 'create', id=uid())['document']
        with self.hub.db() as db:
            db.execute('UPDATE design_documents SET task_links=? WHERE id=?',
                       (json.dumps({'tree_id':self.tree}), legacy['id']))
        self.assertTrue(self.call(design_documents, 'task-sources', task_id=self.task)['problem']['shared'])
        self.assertTrue(self.call(solution_spaces, 'get', task_id=self.task)['shared'])
        detached = self.call(design_documents, 'separate-shared', id=self.task)
        self.assertEqual(detached, self.call(design_documents, 'separate-shared', id=self.task))
        self.assertEqual(detached['task_links']['metric_tree_id'], self.metric)
        self.assertNotEqual(detached['task_links']['tree_id'], self.tree)
        self.assertEqual(self.call(solution_spaces, 'get', task_id=self.task)['saved']['options'], [self.case])
        self.assertFalse(self.call(solution_spaces, 'get', task_id=legacy['id'])['shared'])

    def test_separate_document_clones_stages_and_provenance_once(self):
        self.call(solution_spaces, 'save', task_id=self.task, id=self.tree, options=[self.case],
                  version=0, source_revision=1, request='Кейсы')
        self.call(metric_trees, 'save', draft_task=self.task, id=self.metric, revision=0, title='Метрика',
                  goal='Рост', metrics=[self.node])
        ref = {'tree_id':self.tree, 'title':'Источник', 'revision':1, 'version':1, 'cases':[], 'answers':[],
               'metric_tree':{'id':self.metric, 'title':'Доход', 'goal':'Цель', 'revision':1, 'nodes':[]}}
        self.call(design_documents, 'create', id=self.task, sections=self.sections, title='Продление')
        historical = {**ref, 'tree_id':uid()}
        body = dict(id=uid(), original_id=self.task, sections=self.sections, title='Отдельно',
                    task_links={'tree_id':self.tree, 'cases':[1], 'case_version':1},
                    sources={'target':ref, 'problem':historical})
        copied = self.call(design_documents, 'duplicate', **body)['document']
        self.assertEqual(copied, self.call(design_documents, 'duplicate', **body)['document'])
        links = copied['task_links']
        self.assertNotEqual(links['tree_id'], self.tree)
        self.assertNotEqual(links['metric_tree_id'], self.metric)
        self.assertEqual(copied['sources']['target']['tree_id'], links['tree_id'])
        self.assertEqual(copied['sources']['target']['metric_tree']['id'], links['metric_tree_id'])
        self.assertEqual(copied['sources']['problem']['tree_id'], historical['tree_id'])
        scope = dict(task_id=copied['id'], id=links['tree_id'])
        self.assertEqual(self.call(solution_spaces, 'get', **scope)['saved']['options'], [self.case])
        self.call(solution_spaces, 'save', **scope, options=[{**self.case, 'title':'Новый'}],
                  version=1, source_revision=1)
        self.assertEqual(self.call(solution_spaces, 'get', task_id=self.task)['saved']['options'], [self.case])

    def test_stale_links_and_historical_review(self):
        self.call(metric_trees, 'save', draft_task=self.task, id=self.metric, title='Своя', revision=0,
                  goal='Рост', metrics=[self.node])
        other = uid()
        self.call(design_documents, 'create-task', id=other, title='Другая')
        with self.assertRaises(ContractError):
            self.call(design_documents, 'create', id=other, task_links={'metric_tree_id':self.metric})
        task = self.call(design_documents, 'task-navigation', task_id=other, task_metric_tree_id=self.metric)
        self.assertEqual(task['links'], {})
        with self.assertRaises(ContractError):
            self.call(metric_trees, 'get', task_id=other, id=self.metric)
        ref = {'metric_tree':{'id':self.metric,'title':'Своя','goal':'Рост','revision':1,'nodes':[]}}
        for task_id, expected in [(other, {}), (self.task, {'target':ref['metric_tree']})]:
            with patch('design_assistant.standalone_answer', return_value='[]') as model:
                self.call(design_assistant, 'review', task_id=task_id, title='Ревью', sections=self.sections,
                          sources={'target':ref})
                self.assertEqual(json.loads(model.call_args.args[1])['metric_sources'], expected)
