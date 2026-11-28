import json
import tempfile
import unittest
from unittest.mock import patch
import uuid

from block_contracts import ContractError
from local_workspace import Community, LOCAL_USER
import problem_spaces
import solution_spaces as solutions


class SolutionSpaces(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.hub = Community(temp.name)
        self.tree = {'id': str(uuid.uuid4()), 'title': 'Тест', 'problem': 'Спрос', 'revision': 0,
                     'problem_tree': [{'question': 'Когда?', 'answer': 'Утром', 'children': []}]}
        problem_spaces.request(self.hub, LOCAL_USER, self.tree, 'save')
        self.case = {k: 'пример' for k in solutions.FIELDS} | {'evidence': [1]}

    def call(self, action, **fields):
        return solutions.request(self.hub, LOCAL_USER, {'id': self.tree['id'], **fields}, action)

    def test_generation_and_versioned_source(self):
        with patch('solution_spaces.standalone_answer', return_value=json.dumps([self.case])) as model:
            plan = self.call('generate')
            self.assertEqual(json.loads(model.call_args.args[1])['answers'][0]['answer'], 'Утром')
            self.assertIsNone(self.call('get')['saved'])
            self.call('save', options=plan['options'], version=0, source_revision=1)
            model.return_value = json.dumps([{**self.case, 'evidence': [2]}])
            with self.assertRaises(ContractError):
                self.call('generate')
        self.tree['problem_tree'][0]['answer'] = 'Вечером'
        problem_spaces.request(self.hub, LOCAL_USER, {**self.tree, 'revision': 1}, 'save')
        state = self.call('get')
        self.assertEqual(state['source']['answers'][0]['answer'], 'Вечером')
        self.assertEqual(state['saved']['source']['answers'][0]['answer'], 'Утром')

    def test_append_after_tree_edit_keeps_both_answers(self):
        plan = self.call('get')
        old_answer = plan['source']['answers'][0]
        self.call('save', options=[self.case], version=0, source_revision=1)
        self.tree['problem_tree'][0]['answer'] = 'Вечером'
        problem_spaces.request(self.hub, LOCAL_USER, {**self.tree, 'revision': 1}, 'save')
        retained = {**self.case, 'evidence': [], 'previous_evidence': {'revision': 1, 'answers': [old_answer]}}
        self.call('save', options=[retained, self.case], version=1, source_revision=2)
        saved = self.call('get')['saved']
        cases = [solutions.task_context.case_with_answers(case, saved['source']) for case in saved['options']]
        self.assertEqual([(c['evidence_revision'], c['evidence'][0]['answer']) for c in cases],
                         [(1, 'Утром'), (2, 'Вечером')])

    def test_manual_case_requires_only_a_title_until_research(self):
        case = dict.fromkeys(solutions.FIELDS, '') | {'title': 'Заместитель', 'evidence': []}
        with patch('solution_spaces.standalone_answer') as model, patch('solution_spaces.search') as search:
            self.call('save', options=[case], version=0, source_revision=1)
            self.assertEqual(self.call('get')['saved']['options'], [case])
            with self.assertRaises(ContractError):
                self.call('save', options=[{**case, 'title': '  '}], version=1, source_revision=1)
            with self.assertRaisesRegex(ContractError, 'оба поисковых запроса'):
                self.call('research', case={**case, 'query': 'workflow'}, source_revision=1)
            search.assert_not_called()
            model.assert_not_called()
            search.return_value = ([], [])
            self.call('research', case={**case, 'query': 'workflow', 'business_query': 'approvals'}, source_revision=1)
            search.assert_called_once_with('approvals', 'workflow')
            model.return_value = json.dumps([case])
            with self.assertRaisesRegex(ContractError, 'неполные варианты'):
                self.call('generate')

    def test_outcome_needs_evidence_and_urls_come_from_search(self):
        record = {'title': 'Тест', 'id': 1, 'provider': 'arXiv', 'url': 'https://arxiv.org/abs/example', 'summary': 'Внедрение отложили.'}
        hit = {'id': 1, 'business': 'Похожая цель', 'technical': 'Данные различаются', 'reuse': 'Проверить', 'quote': 'Выручка выросла', 'outcome': 'Успех'}
        with patch('solution_spaces.search', return_value=([record], [])), patch('solution_spaces.standalone_answer') as model:
            model.return_value = json.dumps([hit])
            result = self.call('research', case=self.case, source_revision=1)['sources'][0]
            self.assertEqual(result['outcome'], 'Не установлен')
            self.assertEqual(result['url'], record['url'])
            model.return_value = json.dumps([{**hit, 'quote': record['summary'], 'outcome': 'Неудача'}])
            self.assertEqual(self.call('research', case=self.case, source_revision=1)['sources'][0]['outcome'], 'Неудача')

    def test_independent_methods_and_model_contracts(self):
        defaults = self.call('method')
        def edit(key, text):
            return {key: {'text': text, 'previous': defaults[key]['text']}}
        cases = 'Выделяй отдельный кейс для каждой роли пользователя.'
        research = 'Ищи отчёты о сбоях.'
        self.call('save-method', changes=edit('cases', cases) | edit('research', research))
        with patch('solution_spaces.standalone_answer', return_value=json.dumps([self.case])) as model:
            self.call('generate')
            instruction = model.call_args.args[2]
            self.assertIn(cases, instruction)
            self.assertIn(research, instruction)
            self.assertTrue(instruction.endswith(solutions.CASE_CONTRACT))
        record = {'id':1, 'title':'Разбор сбоя', 'url':'https://example.org/report', 'provider':'Интернет', 'summary':'Отчёт'}
        with patch('solution_spaces.search', return_value=([record], [])) as search, patch('solution_spaces.standalone_answer', return_value='[]') as model:
            self.call('research', case=self.case, source_revision=1)
            search.assert_called_once_with(self.case['business_query'], self.case['query'])
            self.assertIn(research, model.call_args.args[2])
            self.assertNotIn(cases, model.call_args.args[2])
            self.assertTrue(model.call_args.args[2].endswith(solutions.RESEARCH_CONTRACT))
        reset = {'cases':{'text':None, 'previous':cases}}
        with self.assertRaises(ContractError) as conflict:
            self.call('save-method', changes=reset | edit('research', 'Другая версия'))
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(self.call('method')['cases']['text'], cases)
        self.call('save-method', changes=reset)
        with patch.dict(solutions.METHODS, cases='Новые встроенные правила'):
            saved = self.call('method')
            self.assertEqual(saved['cases']['text'], 'Новые встроенные правила')
            self.assertEqual(saved['research']['text'], research)
        self.assertEqual(solutions.request(self.hub, {'id':'other'}, {}, 'method'), defaults)
