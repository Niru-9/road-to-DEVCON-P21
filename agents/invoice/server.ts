/**
 * Invoice agent — receivables, overdue invoices, payment chasing, reconciliation.
 *
 * Deterministic and rule-based. It answers from standard receivables practice and says so,
 * rather than inventing a studio-specific policy it cannot know.
 */

import { startAgent, text, type AgentDefinition } from '../shared/service'

const OVERDUE_MARKERS = ['overdue', 'late', 'past due', 'reminder', 'dunning', 'chase', 'escalat']
const INVOICE_MARKERS = ['invoice', 'invoic', 'bill', 'receivable', 'statement', 'payment due', 'refund', 'credit note']
const RECONCILE_MARKERS = ['twice', 'duplicate', 'double', 'reconcile', 'reimburse', 'overpaid']
const FEE_MARKERS = ['late fee', 'interest', 'penalty', 'surcharge']
const DISPUTE_MARKERS = ['dispute', 'disputed', 'wrong amount', 'incorrect amount']

function answerFor(question: string): { answer: string; notes: string[] } {
  const notes: string[] = []
  const q = question.trim()

  if (text.hasAny(q, DISPUTE_MARKERS)) {
    return {
      answer: [
        'Treat this as a payment dispute, not a chase. Do not send a dunning reminder yet — a disputed amount escalates it into a collections matter and weakens the studio\'s position.',
        '',
        text.bullets([
          'Reply within the payment-terms window with the invoice number, the amount invoiced, the amount received, and the difference.',
          'Reconcile the line items: confirm which delivery or milestone produced each charge before conceding or disputing anything.',
          'Offer one of two resolutions: issue a credit note for the difference, or confirm the charge with the supporting evidence and request the shortfall.',
          'Record the dispute against the invoice so it is excluded from ageing while it is open, and set a date to close it.',
        ]),
        '',
        'I am reasoning from standard receivables practice. I do not know your studio\'s actual payment terms, so confirm the net-terms window and any agreed credit-note policy before sending.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, RECONCILE_MARKERS) && text.hasAny(q, ['paid', 'payment', 'transfer', 'refund', 'reconcile'])) {
    return {
      answer: [
        'A duplicate payment is a trust problem first and an accounting problem second. Reply quickly and in plain terms.',
        '',
        text.bullets([
          'Confirm receipt of both amounts with the bank references, so the client sees you have matched them.',
          'Refund the duplicate by the same route the payment arrived, within the studio\'s normal refund window.',
          'Void the duplicate receipt or mark the second payment as unapplied, so ageing is not inflated by money the studio does not expect to keep.',
          'Send the reconciliation summary: invoice number, both payments, amount refunded, and the resulting balance — which should be zero.',
          'Check the payment rail\'s duplicate-reference window before assuming the client can simply stop the second transfer; once settled, a refund is the only route.',
        ]),
        '',
        'I am reasoning from standard accounting practice. I do not know your studio\'s refund window, so confirm it before promising a date.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, FEE_MARKERS) || text.hasAny(q, OVERDUE_MARKERS)) {
    const mentionsFee = text.hasAny(q, FEE_MARKERS)
    const days = /\b(\d{1,4})\s*(?:days?)\b/i.exec(q)?.[1]

    if (mentionsFee) {
      notes.push('Late-fee question: the fee must be in the contract or on the face of the invoice to be enforceable.')
    }
    if (days !== undefined) {
      notes.push(`Request mentions a ${days}-day delay; ageing starts from the invoice due date, not the date of the request.`)
    }

    return {
      answer: [
        'For an overdue invoice, the tone matters more than the pressure: a clear statement of what is owed and by when, with one specific ask.',
        '',
        text.bullets([
          'Open with the facts: invoice number, amount, original due date, and days outstanding.',
          'Restate the accepted payment methods and give a specific, realistic date for payment.',
          'State the consequence once, calmly: further work will pause until the balance clears. No threats, no urgency theatre.',
          'Ask for a date and a reason if payment is not immediate, so the follow-up is a conversation rather than a chase.',
          'Keep the thread on one channel. Escalate to a phone call only after a written reminder goes unanswered.',
        ]),
        '',
        'On the late fee specifically:',
        '  - A late fee is only chargeable if it is in the contract or printed on the invoice. If it is not in either, do not invent one now.',
        '  - If it is agreed, apply the stated percentage to the overdue amount, not to interest on interest.',
        '  - Check any statutory or contractual cap before applying it, and be ready to waive it once.',
        '',
        'I am reasoning from standard receivables practice. I do not know your studio\'s payment terms, late-fee policy or collection history with this client, so confirm those before sending.',
      ].join('\n'),
      notes,
    }
  }

  if (text.hasAny(q, INVOICE_MARKERS)) {
    return {
      answer: [
        'For invoice work, I work from: the invoice number, the amount, the due date, and what the client disputes, if anything.',
        '',
        text.bullets([
          'Ageing report: bucket every open invoice by days outstanding so the biggest exposure is visible first.',
          'Dunning cadence: day 1 friendly, day 7 formal, day 14 call, day 30 final notice — then stop spending time on it.',
          'Every invoice should state tax, the net-terms window, the accepted payment routes, and the late-fee policy if there is one.',
        ]),
        '',
        'Tell me the invoice number and what you need — wording, a payment plan, or a reconciliation — and I will be specific.',
      ].join('\n'),
      notes,
    }
  }

  return {
    answer: [
      'I am the invoice helper, so I answer receivables questions: overdue balances, reminder wording, late fees, payment plans, credits and reconciliation.',
      '',
      'Useful things to send me:',
      text.bullets([
        'An invoice number with the amount and the date it fell due.',
        'The exact situation: overdue, disputed, paid twice, or about to be issued.',
        'What you want back: a reminder email, a reply to a dispute, or a reconciliation note.',
      ]),
      '',
      'I do not know your studio\'s payment terms or fee policy, so I will always mark that as an assumption rather than inventing it.',
    ].join('\n'),
    notes,
  }
}

const definition: AgentDefinition = {
  slug: 'invoice',
  displayName: 'Invoice helper',
  capability:
    'Handles invoices and receivables: overdue balances, dunning and reminder wording, late-fee questions, payment plans, credits and payment reconciliation.',
  accepts:
    'A question about an invoice, an overdue amount, a late fee, a disputed amount, a duplicate payment, or a request for reminder wording.',
  version: '1.0.0',
  portEnvVar: 'AGENT_INVOICE_PORT',
  defaultPort: 8_791,
  handle: answerFor,
}

startAgent(definition)