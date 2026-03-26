---
name: codex-to-im
description: Use this skill when working through Codex-to-IM and you need Codex to send a local image or file back to the current IM chat. It teaches the attachment-send protocol and when to use it.
---

# Codex-to-IM attachment sending

Use this skill only when the user is chatting through Codex-to-IM and wants you to send a generated or existing local artifact back to the IM chat.

## What this skill does

Codex-to-IM can send local files back to the chat after your reply. You trigger that by including one or more `<cti-send>...</cti-send>` blocks in your final answer.

Supported artifact kinds:

- `image`
- `file`

## Required format

Output valid JSON inside the block, with no markdown fence.

Single artifact:

```text
<cti-send>
{"type":"image","path":"D:\\path\\to\\result.png","caption":"optional caption"}
</cti-send>
```

or

```text
<cti-send>
{"type":"file","path":"D:\\path\\to\\report.pdf","caption":"optional caption"}
</cti-send>
```

Multiple artifacts:

```text
<cti-send>
{"items":[
  {"type":"image","path":"D:\\path\\to\\result.png"},
  {"type":"file","path":"D:\\path\\to\\report.pdf"}
]}
</cti-send>
```

## Rules

- The `path` must be an absolute local path.
- The file must already exist before you emit the block.
- Keep normal user-facing explanation outside the `<cti-send>` block.
- Do not invent artifacts that were not actually created or found.
- If you are unsure whether the file exists, verify first.
- If the channel probably does not support the artifact well, explain that plainly instead of inventing a successful send.

## When to use

Use this protocol when the user asks you to:

- send a generated chart, diagram, screenshot, or edited image
- send a report, archive, patch, PDF, spreadsheet, or other output file
- send the final result as an attachment instead of only pasting text

Do not use it for ordinary text replies.
