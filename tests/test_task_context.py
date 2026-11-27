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
