/**
 * Brand-copy agent — writing and rewriting the studio's own words.
 *
 * Deterministic and rule-based. It produces drafts in a stated voice, shows the choices it
 * made, and never claims the brand voice is exactly right without the studio confirming it.
 */

import { startAgent, text, type AgentDefinition } from '../shared/service'

const REWRITE_MARKERS = ['rewrite', 'rework', 'revise', 'resay', 'redo', 'rephrase', 'stop sounding', 'reads like']
const TAGLINE_MARKERS = ['tagline', 'slogan', 'strapline', 'one-liner', 'elevator pitch', 'pith']
const ABOUT_PAGE_MARKERS = ['about page', 'about us', 'bio', 'story', 'landing page', 'homepage']
const STUDIO_VOICE_MARKERS = ['voice', 'tone', 'brand', 'studio', 'copy', 'marketing', 'website']
const CERAMIC_MARKERS = ['ceramic', 'clay', 'kiln', 'pottery', 'potter', 'wood-fired', 'wood firing', 'glaze']
const TECHNICAL_MARKERS = ['how do i', 'how do you', 'process', 'technique', 'kiln schedule', 'firing']

/** The voice rules this agent applies. Stated in the answer so the studio can argue with them. */
const VOICE_RULES = [
  'Say what the studio does before saying how it feels about it.',
  'Concrete nouns over adjectives: name the material, the firing, the surface.',
  'Short sentences. Long ones sound like marketing.',
  'First person plural for the studio, second person for the reader.',
  'Never use "passionate", "journey", "bespoke", "unique", or "elevate".',
] as const

function answerFor(question: string): { answer: string; notes: string[] } {
  const notes: string[] = []
  const q = question.trim()

  if (text.hasAny(q, TAGLINE_MARKERS)) {
    const subject = text.hasAny(q, CERAMIC_MARKERS)
      ? 'a ceramics studio that fires in wood'
      : 'the studio'

    if (subject.includes('wood')) {
      notes.push('Ceramic-specific: lead with the firing, because that is the hard part and the differentiator.')
    }

    return {
      answer: [
        'Three directions, deliberately different rather than three variations of one idea.',
        '',
        text.bullets([
          '**Fire, then form.** Wood kilns decide what a piece becomes. We fire slowly and sell the result.',
          '**Made by fire, not by template.** Every piece comes out of the kiln different, because wood does not repeat itself.',
          '**A kiln, not a factory.** We fire in wood, take what the fire gives us, and glaze the rest.',
        ]),
        '',
        'Voice rules I applied:',
        text.bullets(VOICE_RULES),
        '',
        'If you tell me the actual constraint — budget, whether you sell to restaurants or direct, whether the word "kiln" is too technical for your client — I can cut this down to one.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, REWRITE_MARKERS)) {
    notes.push('Rewrite request: the deliverable is a draft plus the reason for each change, not a polished secret.')
    return {
      answer: [
        'Here is how I would approach a rewrite, and what I would change.',
        '',
        '1. Keep every concrete noun. Materials, temperatures, surfaces and numbers stay — they are the only specific things in the copy.',
        '2. Cut the emotion words and keep the actions. "We are passionate about wood firing" becomes "we fire in wood".',
        '3. Cut hedges: "we believe that it is possible to" becomes "we".',
        '4. Cut the throat-clearing opener. If the first sentence does not say what the studio does, it is wasted.',
        '5. Read it aloud. Anything you stumble over is not a sentence yet.',
        '',
        'Voice rules I applied:',
        text.bullets(VOICE_RULES),
        '',
        'Paste the actual text and I will return a rewritten version with the changes marked, plus the reasons. Without the text I can only describe the pass, which is less useful than it sounds.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, ABOUT_PAGE_MARKERS)) {
    return {
      answer: [
        'A studio About page has one job: tell a reader what this place makes and why it is different. Everything else is a page of its own.',
        '',
        'Suggested structure:',
        text.bullets([
          'One sentence on what you make.',
          'One paragraph on how you make it — the firing, the clay, the process. This is the paragraph that sounds like a person, because it is specific.',
          'One paragraph on who buys it and what they use it for.',
          'One line about where the work can be seen or bought.',
          'No mission statement. No "passionate about". No founding-myth paragraph unless it is genuinely interesting.',
        ]),
        '',
        'Voice rules I applied:',
        text.bullets(VOICE_RULES),
        '',
        'Send me the current text and I will return a rewritten draft with the changes marked.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, TECHNICAL_MARKERS)) {
    return {
      answer: [
        'That is a how-do-we-do-it question rather than a copy question — I would be guessing at your process.',
        '',
        'I write and rewrite words. If you need the process itself described for a client, the studio should confirm the facts and I will turn them into the copy.',
        '',
        'Send me the facts as a list and I will write them up.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, STUDIO_VOICE_MARKERS)) {
    return {
      answer: [
        'I am the brand-copy helper. I write and rewrite the studio\'s words: taglines, About and home page copy, product descriptions, emails and captions — in a consistent voice.',
        '',
        'The voice I write in, unless you tell me otherwise:',
        text.bullets(VOICE_RULES),
        '',
        'Useful things to send me:',
        text.bullets([
          'The text you want rewritten, or the thing you want written.',
          'Who is reading it: a gallery visitor, a restaurant buyer, a collector, or a press writer.',
          'Any words you never want to see, and any words you insist on.',
        ]),
        '',
        'I will show the draft and the reason for each change, so the voice is a decision the studio makes rather than one I invent.',
      ].join('\n'),
      notes,
    }
  }

  return {
    answer: [
      'I am the brand-copy helper, so I write and rewrite the studio\'s words: taglines, About and home page copy, product descriptions, emails and captions.',
      '',
      'Send me the copy you want written or rewritten, and tell me who is reading it. I will show the draft and the reason for each change.',
    ].join('\n'),
    notes,
  }
}

const definition: AgentDefinition = {
  slug: 'brand-copy',
  displayName: 'Brand copy helper',
  capability:
    'Writes and rewrites the studio\'s own words: taglines, About and home page copy, product descriptions, emails and captions, in one consistent voice with the changes explained.',
  accepts:
    'A writing or rewriting request — a tagline, a paragraph, an About page, a product description, an email or a caption — ideally with who is reading it.',
  version: '1.0.0',
  portEnvVar: 'AGENT_BRAND_PORT',
  defaultPort: 8_793,
  handle: answerFor,
}

startAgent(definition)