import { test, expect } from 'claude-code/testing'
import { redact } from '../hooks/redact'

const SECRETS = [
  'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
  'AKIAIOSFODNN7EXAMPLE',
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  'AIzaSyA1234567890abcdefghijklmnopqrstuv',
  'xoxb-123456789012-abcdefghijkl',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123def456',
]

test('each known secret shape is replaced before text leaves the machine', () => {
  for (const secret of SECRETS) {
    const { text } = redact(`use ${secret} for the call`)
    expect(text).not.toContain(secret)
    expect(text).toContain('«secret-1»')
  }
})

test('key=value assignments of sensitive names are redacted, the name kept', () => {
  const { text } = redact('set password=hunter2 and API_KEY: abc123 then run it')
  expect(text).toBe('set password=«secret-1» and API_KEY: «secret-2» then run it')
})

test('private key blocks are redacted whole', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
  expect(redact(`key:\n${pem}`).text).toBe('key:\n«secret-1»')
})

test('restore puts the originals back wherever the placeholders survived', () => {
  const { text, restore } = redact('call with token=abc123 please')
  expect(restore(`Call the API with ${text.match(/«secret-\d»/)![0]}.`)).toBe('Call the API with abc123.')
})

test('text without secrets is unchanged', () => {
  expect(redact('rename foo to bar in utils.ts').text).toBe('rename foo to bar in utils.ts')
})
