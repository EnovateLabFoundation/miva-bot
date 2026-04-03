# Miva LMS - Training Rulebook

This document records the visual patterns and human navigation instincts extracted from the training videos provided by the user.

### Zone 1: The Content Container (High Priority)
- **Buttons**: "Next page", "Continue", "Mark as done", "Submit all and finish".
- **Selectors**: `.course-content`, `#region-main`.
- **Logic**: These are usually located inside the white content box at the center-bottom. **MUST be exhausted before looking at the Sidebar or Footer.**
- **Quiz End-Game**: When you see "Summary of attempt", scroll to the bottom of Zone 1 for the final "Submit all and finish" button.
- **Assignments**: If you see "Add submission", stop and alert the user.

### Zone 2: The Right Sidebar (Critical for Assessments)
- **Buttons/Links**: "Finish attempt...", Question Numbers (1, 2, 3...).
- **Selectors**: `.block_quiz_navigation`, `.block_navigation`.
- **Logic**: Use this to jump between questions or trigger the final submission flow when no more "Next page" buttons exist in the container.

### Zone 3: The Gray Footer (Last Resort)
- **Buttons**: "Next activity >", "Previous activity <", "Jump to..." dropdown.
- **Selectors**: `.section-navigation`, `.footer-content`.
- **Logic**: These move to entirely new modules. Use these only when Zone 1 and Zone 2 show no further action is possible within the current activity.

### State Awareness & Recovery
- **Current Position**: Look for **BOLD TEXT** in the left-hand navigation sidebar to identify the active module.
- **GPS**: Use **Breadcrumbs** (at the top) following the pattern `Course / Group / Activity` to re-orient if a click leads to an unexpected page.
- **Escape Hatch**: If no buttons match, use the "**Jump to...**" dropdown at the bottom center to select the next logical step.
