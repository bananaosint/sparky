// F7: a plan approved in plan mode is saved as docs/design/YYYY-MM-DD--<slug>--design.md.

const MAX_SLUG = 60

function slugOf(title: string) {
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  // Cut on a word, so the name never ends mid-word.
  if (slug.length > MAX_SLUG) slug = slug.slice(0, MAX_SLUG + 1).replace(/-[^-]*$/, '').slice(0, MAX_SLUG)
  return slug || 'plan'
}

// The file name for a plan, from its first heading (else its first line); a name
// already taken that day gets -2, -3….
export function designDocName(plan: string, date: string, taken: ReadonlySet<string>): string | undefined {
  const title = /^\s*#{1,6}\s+(.*\S)/m.exec(plan)?.[1] ?? plan.split('\n').map((l) => l.trim()).find(Boolean)
  if (!title) return undefined
  const slug = slugOf(title)
  let name = `${date}--${slug}--design.md`
  for (let n = 2; taken.has(name); n++) name = `${date}--${slug}-${n}--design.md`
  return name
}
