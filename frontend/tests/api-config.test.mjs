import assert from 'node:assert/strict'
import test from 'node:test'
import { apiBase } from '../src/api.ts'

test('Development keeps the existing separate localhost Backend', () => {
  assert.equal(apiBase(undefined, true), 'http://localhost:8000')
})
test('Production build defaults to the same origin without a fixed deployment URL', () => {
  assert.equal(apiBase(undefined, false), '')
  assert.equal(apiBase('', true), '')
})
test('Optional public base preserves the API paths and trims trailing separators', () => {
  assert.equal(apiBase(' https://api.example.invalid/// ', false), 'https://api.example.invalid')
  assert.equal(`${apiBase('', false)}/tasks/1`, '/tasks/1')
})
