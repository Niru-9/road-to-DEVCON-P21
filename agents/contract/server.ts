/**
 * Contract agent — reading and interpreting commercial terms.
 *
 * Deterministic and rule-based. It reads clauses, names what is uncertain and says what a
 * lawyer needs to look at. It never gives a legal opinion it cannot support.
 */

import { startAgent, text, type AgentDefinition } from '../shared/service'

const CLAUSE_MARKERS = ['clause', 'contract', 'agreement', 'terms', 'msa', 'sow', 'nda', 'agreement states']
const EXCLUSIVITY_MARKERS = ['exclusiv', 'logo', 'trademark', 'brand asset', 'licence', 'license', 'press release']
const TERMINATION_MARKERS = ['terminat', 'notice period', 'exit', 'end the agreement', 'cancellation']
const RENEWAL_MARKERS = ['renew', 'evergreen', 'auto-renew', 'roll over']
const PAYMENT_MARKERS = ['payment terms', 'net 30', 'net 60', 'late payment', 'milestone', 'retainer']
const IP_MARKERS = ['ownership', 'copyright', 'ip', 'intellectual property', 'work made for hire', 'licence', 'license']
const NDA_MARKERS = ['nda', 'non-disclosure', 'confidential']

function answerFor(question: string): { answer: string; notes: string[] } {
  const notes: string[] = []
  const q = question.trim()

  if (text.hasAny(q, TERMINATION_MARKERS)) {
    const days = /\b(\d{1,4})\s*(?:days?'?\s*)?(?:notice|written notice)\b/i.exec(q)?.[1]
    if (days !== undefined) notes.push(`Notice period in the request: ${days} days.`)

    return {
      answer: [
        'Termination turns on three things: the notice period, when it may be served, and what happens to work and payment on exit.',
        '',
        text.bullets([
          `Read the notice clause literally. If it says 30 days' written notice, count from the day the notice is received, not the day it is sent, unless the contract says otherwise.`,
          'Check whether notice has a permitted method and address. Email to an unmonitored inbox is a frequent source of disputes.',
          'Look for a cure period: many agreements only allow termination for a breach that goes uncured for a stated number of days.',
          'Check the effect-of-termination clause: which licences survive, whether paid-but-undelivered work is refunded, and what happens to outstanding invoices.',
          'Check for a termination fee or an early-exit charge. Its absence or presence usually changes the commercial answer more than the dates do.',
          'Day-of-week usually does not decide anything unless the clause says a notice takes effect at the start of a business day. A Friday the 13th is only relevant if the clause ties effect to notice receipt.',
        ]),
        '',
        'I can tell you which clauses decide this. I am not a lawyer and this is not legal advice — have the notice and effect-of-termination clauses reviewed before you act.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, EXCLUSIVITY_MARKERS) && text.hasAny(q, ['exclusiv', 'forever', 'perpetual', 'any press release', 'all press'])) {
    notes.push('Word scope and duration wording are doing the work here — check both in the clause itself.')

    return {
      answer: [
        'On the wording you described — "any press release, forever" — that is a very broad grant, and it reads as non-exclusive unless the clause says otherwise. Three things decide it.',
        '',
        text.bullets([
          'Exclusivity is an explicit grant. A licence that says the client may use the asset "in any press release" grants a permission; it does not withhold it from anyone else. Exclusive means "and nobody else may", usually for a defined category, market, or period.',
          'Duration: "forever" or "perpetual" survives the agreement. Check whether the agreement has a termination clause that revokes licences on exit, and whether it carves out anything from termination.',
          'Scope: "press releases" is narrower than "publicity". "Any press release" permits press releases; it does not automatically permit paid advertising, social posts, or the client\'s own website. If the studio intended a broad permission, that is a mismatch worth fixing in writing.',
          'Irrevocability matters: a licence described as irrevocable cannot be withdrawn, so the studio should confirm it is not also described as irrevocable before granting perpetual use.',
        ]),
        '',
        'Practical reading: this looks like a broad, perpetual, non-exclusive licence — good for the client, restrictive for the studio. If exclusivity was intended, it is not in this wording.',
        '',
        'I am reading your description, not the contract. Have the grant, duration and termination clauses reviewed by a lawyer before you rely on this.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, RENEWAL_MARKERS)) {
    return {
      answer: [
        'Renewal clauses are decided by the notice window, not the term.',
        '',
        text.bullets([
          'Find the auto-renewal clause and the notice deadline that turns it off. A 12-month term with 60 days\' notice means the decision point is a month before expiry, not on the expiry date.',
          'Check whether the deadline is "before" or "within" a window, and count from the anniversary, not from the invoice date.',
          'Check whether renewal changes price. Many agreements step up at renewal, which is often the real cost of missing the deadline.',
          'Set a calendar reminder at the deadline minus a safety margin. This is the most commonly missed clause in a studio\'s contracts.',
        ]),
        '',
        'I am reasoning from how these clauses are usually written. Check the actual wording before relying on the dates.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, IP_MARKERS) && text.hasAny(q, CLAUSE_MARKERS.concat(['work made for hire', 'ownership']))) {
    return {
      answer: [
        'Intellectual property in a services agreement turns on three separate questions that are often blurred together.',
        '',
        text.bullets([
          'When does ownership transfer — on creation, on payment, or on delivery of final files? "Work made for hire" only reaches what the law already defines as a hire.',
          'What is licensed rather than assigned? Brand assets, fonts and stock photography are almost always licensed, never assigned, because the studio does not own them outright.',
          'What survives termination? A perpetual, irrevocable licence to the studio\'s name and logo for portfolio use is common and usually worth asking for explicitly.',
        ]),
        '',
        'Check the clause for who owns the underlying materials too: raw files, working files and drafts are often retained by the studio even when final deliverables are assigned.',
        '',
        'I am not a lawyer and this is not legal advice.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, NDA_MARKERS)) {
    return {
      answer: [
        'A useful NDA says what is confidential, who it covers, how long it lasts, and what happens at exit.',
        '',
        text.bullets([
          'Definition of confidential information: "all information disclosed" is broad and hard to administer. Narrower, defined categories are easier to enforce and easier for the client to live with.',
          'Carve-outs: public information, already-known information and independently developed work should be excluded, or the agreement can become unusable in a dispute.',
          'Permitted disclosure: can the recipient disclose to employees and contractors? Under what confidentiality duty? A studio needs this to run the work at all.',
          'Duration: confidentiality obligations that survive forever are enforceable in some jurisdictions and not others. A fixed period tied to the information\'s nature is usually cleaner.',
          'Return or destruction at exit, with a narrow carve-out for one archival copy and for legal or regulatory retention.',
        ]),
        '',
        'I am describing how these clauses usually work. I am not a lawyer and this is not legal advice.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, PAYMENT_MARKERS)) {
    return {
      answer: [
        'Payment terms are decided by the trigger, the window and the consequence.',
        '',
        text.bullets([
          'Trigger: net 30 from invoice date, from receipt, or from delivery? They are different clocks, and the difference matters when a client is slow to acknowledge receipt.',
          'Milestone or retainer: if payment is milestone-based, name the milestone and what counts as its completion. Vague milestones are the most common cause of a late invoice.',
          'Consequence: is there a right to suspend work, a late-payment charge, or a right to terminate for non-payment? A consequence that is not written down is not one.',
          'Set-off: check whether the client may withhold payment for a disputed amount without suspending the rest. Ideally the clause caps set-off to the disputed amount.',
        ]),
        '',
        'I am reasoning from how commercial terms are usually drafted. Check the actual clause before relying on it.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, CLAUSE_MARKERS)) {
    return {
      answer: [
        'I read contracts clause by clause. Send me the specific clause or the sentence you are unsure about, and I will tell you what it decides and what it leaves open.',
        '',
        text.bullets([
          'Clauses I can help with most: termination and notice, payment terms and late fees, IP ownership and licences, confidentiality, exclusivity and non-competes, liability caps and indemnities, and renewal.',
          'The most useful detail you can give me: the exact wording, plus what the studio wants to happen and what it currently happens.',
        ]),
        '',
        'I am not a lawyer and this is not legal advice — I help you work out which clause to read and what to ask.',
      ].join('\n'),
      notes,
    }
  }

  return {
    answer: [
      'I am the contract helper, so I read commercial terms: termination and notice, payment and late fees, IP ownership and licences, confidentiality, exclusivity, and renewal.',
      '',
      'Useful things to send me:',
      text.bullets([
        'The clause itself, or the sentence you are unsure about.',
        'What the studio wants to happen, and what currently happens instead.',
        'Any dates, amounts or notice windows the clause mentions.',
      ]),
      '',
      'I am not a lawyer and this is not legal advice. I tell you which clause decides the question and what to ask about it.',
    ].join('\n'),
    notes,
  }
}

const definition: AgentDefinition = {
  slug: 'contract',
  displayName: 'Contract helper',
  capability:
    'Reads and interprets commercial contract terms: termination and notice, payment and late fees, IP ownership and licences, confidentiality, exclusivity, liability and renewal clauses.',
  accepts:
    'A contract question, a clause you are unsure about, or contract wording you want explained — ideally with the exact sentence or clause quoted.',
  version: '1.0.0',
  portEnvVar: 'AGENT_CONTRACT_PORT',
  defaultPort: 8_792,
  handle: answerFor,
}

startAgent(definition)