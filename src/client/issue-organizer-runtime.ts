import { boundAssessmentPrompt } from './assessment-prompts.ts'
import { assessmentCall, currentAssessmentSession } from './assessment.ts'
import { submitIssueOrganization, type IssueOrganizerInputActions } from './issue-organizer.ts'
/** Bound discussions retain the target and already granted write authority. */
export async function submitBoundIssueOrganization(actions: IssueOrganizerInputActions): Promise<void> {
  const sessionId = currentAssessmentSession()
  if (!sessionId) return submitIssueOrganization(actions)
  const { binding } = await assessmentCall<{ binding: { url: string } | null }>({
    action: 'discussion-context',
    sessionId,
  })
  if (!binding) return submitIssueOrganization(actions)
  actions.setDraft(boundAssessmentPrompt(binding.url))
  actions.submit()
}
