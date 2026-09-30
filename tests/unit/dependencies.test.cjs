const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importKnowledgeFile } = require('../../src/main/document-import');

test('upgraded Office parser imports actual PPTX and RTF files through the application', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-office-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const PptxGenJS = require('pptxgenjs');
  const presentation = new PptxGenJS();
  const slide = presentation.addSlide();
  slide.addText('现代化兼容性检查', { x: 1, y: 1, w: 5, h: 1 });
  slide.addNotes('Speaker note preserved');
  const file = path.join(directory, 'test.pptx');
  await presentation.writeFile({ fileName: file });
  const result = await importKnowledgeFile(file, { targetDir: directory });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.content.includes('现代化兼容性检查'));
  assert.ok(result.content.includes('Speaker note preserved'));

  const rtf = path.join(directory, 'test.rtf');
  fs.writeFileSync(rtf, String.raw`{\rtf1\ansi Modern parser compatibility\par Second paragraph}`);
  const richText = await importKnowledgeFile(rtf, { targetDir: directory });
  assert.equal(richText.ok, true, richText.error);
  assert.ok(richText.content.includes('Modern parser compatibility'));
  assert.ok(richText.content.includes('Second paragraph'));

  const AdmZip = require('adm-zip');
  const archive = new AdmZip();
  archive.addFile('mimetype', Buffer.from('application/vnd.oasis.opendocument.text'));
  archive.addFile(
    'content.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:p>ODT 文本兼容检查</text:p></office:text></office:body></office:document-content>',
    ),
  );
  const odt = path.join(directory, 'test.odt');
  archive.writeZip(odt);
  const { extractWordText } = require('../../src/main/word-tools');
  const word = await extractWordText(odt, 'text');
  assert.equal(word.ok, true, word.error);
  assert.ok(word.content.includes('ODT 文本兼容检查'));
});

test('upgraded mail libraries compile and parse Unicode MIME locally without SMTP', async () => {
  const nodemailer = require('nodemailer');
  const { simpleParser } = require('mailparser');
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const message = await transport.sendMail({
    from: 'sender@example.invalid',
    to: 'recipient@example.invalid',
    subject: '邮件兼容性检查',
    html: '<p>中文正文 <strong>important</strong></p>',
    text: '中文正文 important',
    attachments: [{ filename: '测试.txt', content: Buffer.from('附件内容') }],
  });
  assert.ok(Buffer.isBuffer(message.message));
  const parsed = await simpleParser(message.message);
  assert.equal(parsed.subject, '邮件兼容性检查');
  assert.ok(parsed.text.includes('中文正文'));
  assert.ok(parsed.text.includes('important'));
  assert.equal(parsed.attachments[0].filename, '测试.txt');
  assert.equal(parsed.attachments[0].content.toString(), '附件内容');

  const htmlMessage = await transport.sendMail({
    from: 'sender@example.invalid',
    to: 'recipient@example.invalid',
    html: '<p>中文转换 <strong>important</strong></p>',
  });
  const htmlParsed = await simpleParser(htmlMessage.message);
  assert.ok(htmlParsed.text.includes('中文转换'));
  assert.ok(htmlParsed.text.includes('important'));
});
