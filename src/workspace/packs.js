/**
 * WORKSPACE PACKS — one per family of professions.
 * -------------------------------------------------------------------------
 * Doctors, advocates and business owners have their own workspaces
 * (clinic/, pro/). Everyone else — an engineer, a teacher, a CA, a driver,
 * a student, a homemaker — gets a workspace built from one of these packs
 * (owner, 2026-11-21: "a full detailed, structured task ... so that I can,
 * as an engineer, plan our day and automate that").
 *
 * A pack is DATA, served as-is to the app (GET /workspace), so a new
 * profession is a new entry here, not a new screen:
 *
 *   day       the shape of a typical working day: time blocks the AI plan
 *             starts from and the app shows when there is no plan yet
 *   routines  automations the user switches on with one tap — each becomes
 *             a repeating reminder (reminders/store.js `repeat`), spoken or
 *             pushed at its time, and switched off the same way
 *   actions   one-tap requests handed to the assistant ("Draft my stand-up")
 *   focus     the default deep-work session length, in minutes
 *
 * Matching: the user's own profession text first (users.profession, e.g.
 * "Chartered Accountant"), then their persona, then "general".
 *
 * Copy follows the app's formal style (Title Case titles, full sentences).
 * Nothing here gives medical, legal or financial advice: health-staff and
 * finance routines remind and organise; they never decide.
 */

/** A routine: id, title, detail, time "HH:MM", repeat daily|weekly|monthly,
 *  weekday (0 = Sunday, weekly), monthDay (monthly), text (the reminder). */
const r = (id, title, detail, time, repeat, text, extra = {}) =>
  ({ id, title, detail, time, repeat, text, ...extra });
/** A day block: start, end ("HH:MM"), title, kind focus|meeting|admin|break|task|personal. */
const b = (start, end, title, kind) => ({ start, end, title, kind });
/** A quick action: label, icon (Material name the app maps), ask (sent to the assistant). */
const a = (label, icon, ask) => ({ label, icon, ask });

const PACKS = [
  {
    id: "engineering",
    title: "Engineering Workspace",
    tagline: "Ship focused work, keep the team unblocked and close every day with a plan.",
    match: /\b(software|developer|programmer|engineer\w*|devops|sre|qa|tester|data scien\w*|analyst|product manager|designer|ux|ui|architect|it|tech)\b/i,
    focus: 90,
    day: [
      b("09:15", "09:30", "Prepare stand-up: yesterday, today, blockers", "admin"),
      b("09:30", "09:45", "Team stand-up", "meeting"),
      b("10:00", "12:30", "Deep work on the top-priority task", "focus"),
      b("12:30", "13:15", "Lunch break", "break"),
      b("14:00", "15:00", "Code and design reviews", "task"),
      b("15:00", "16:30", "Meetings and unblocking others", "meeting"),
      b("16:30", "17:45", "Second focus block: smaller tasks and fixes", "focus"),
      b("17:45", "18:00", "Wrap up: update tickets and plan tomorrow's top three", "admin"),
    ],
    routines: [
      r("standup", "Stand-Up Preparation", "A nudge to note yesterday's work, today's plan and blockers.", "09:15", "daily",
        "Prepare your stand-up: what you finished yesterday, what you will do today, and any blockers."),
      r("deepwork", "Morning Deep Work", "Protects 10:00 for your most important task.", "10:00", "daily",
        "Deep work time. Close chat and email and start your top-priority task."),
      r("wrapup", "End-of-Day Wrap-Up", "Log what you finished and choose tomorrow's top three.", "17:45", "daily",
        "Wrap up the day: update your tickets, note what you finished and choose tomorrow's top three."),
      r("weekly", "Weekly Status Report", "Every Friday, a reminder to send your weekly update.", "16:30", "weekly",
        "Time to send your weekly status report: progress, risks and next week's plan.", { weekday: 5 }),
    ],
    actions: [
      a("Draft My Stand-Up", "record_voice_over", "Draft my stand-up update for today from what I worked on yesterday and what is planned today."),
      a("Plan My Day", "event_note", "Plan my working day around my meetings, with two deep-work blocks for my top priorities."),
      a("Weekly Status Report", "summarize", "Draft my weekly status report: what I delivered, what is in progress, risks and next week's plan."),
      a("Prepare My Next Meeting", "groups", "Prepare me for my next meeting: who is attending, the agenda and the points I should raise."),
      a("Break Down a Task", "account_tree", "Help me break my current task into small, estimable steps."),
      a("Write a Technical Note", "description", "Help me write a clear technical note or design summary for my team."),
    ],
  },
  {
    id: "education",
    title: "Teaching Workspace",
    tagline: "Lessons prepared, papers graded and every parent kept informed.",
    match: /\b(teacher|professor|lecturer|tutor|coach|trainer|educator|faculty|principal)\b/i,
    focus: 60,
    day: [
      b("07:30", "08:00", "Review today's lesson plans and materials", "admin"),
      b("08:00", "13:00", "Classes", "meeting"),
      b("13:00", "13:45", "Lunch break", "break"),
      b("14:00", "15:30", "Grading and feedback", "focus"),
      b("15:30", "16:30", "Student and parent follow-ups", "task"),
      b("19:00", "19:45", "Prepare tomorrow's lessons", "focus"),
    ],
    routines: [
      r("lessonreview", "Morning Lesson Review", "Run through today's lesson plans before class.", "07:30", "daily",
        "Review today's lesson plans and check you have every material you need."),
      r("grading", "Grading Block", "A daily reminder to grade and give feedback.", "14:00", "daily",
        "Grading time. Mark today's work and note feedback for students who need it."),
      r("prep", "Tomorrow's Preparation", "Prepare the next day's lessons each evening.", "19:00", "daily",
        "Prepare tomorrow's lessons and print or share any materials."),
      r("parents", "Weekly Parent Updates", "Every Friday, send updates to the parents who need one.", "16:00", "weekly",
        "Send this week's updates to parents, starting with students who need extra support.", { weekday: 5 }),
    ],
    actions: [
      a("Draft a Lesson Plan", "menu_book", "Draft a lesson plan with objectives, activities and a short assessment for my next class."),
      a("Create a Quiz", "quiz", "Create a ten-question quiz with answers on the topic I am teaching this week."),
      a("Write to a Parent", "mail", "Help me write a polite, clear message to a parent about their child's progress."),
      a("Plan My Week", "calendar_month", "Plan my teaching week: classes, grading time and preparation."),
      a("Explain a Topic Simply", "lightbulb", "Help me explain a difficult topic simply, with an everyday example for students."),
      a("Track Homework", "checklist", "Remind me which homework and assignments are due this week."),
    ],
  },
  {
    id: "finance",
    title: "Finance & Compliance Workspace",
    tagline: "Deadlines tracked, clients answered and every billable hour logged.",
    match: /\b(chartered accountant|\bca\b|accountant|auditor|banker|bank|financial advisor|finance|company secretary|tax|legal consultant|actuary|investment)/i,
    focus: 90,
    day: [
      b("09:30", "10:15", "Client emails and queries", "admin"),
      b("10:30", "12:30", "Filings, reconciliations and reports", "focus"),
      b("12:30", "13:15", "Lunch break", "break"),
      b("14:00", "15:30", "Client meetings and calls", "meeting"),
      b("15:30", "16:30", "Review statutory due dates and pending documents", "task"),
      b("17:45", "18:00", "Log billable hours and plan tomorrow", "admin"),
    ],
    routines: [
      r("duedates", "Due-Date Check", "Each morning, review the deadlines you have noted for the week.", "09:15", "daily",
        "Check this week's filing and compliance due dates, and the documents still pending from clients."),
      r("monthclose", "Month-End Close", "On the 25th, start the month-end close and filings.", "10:00", "monthly",
        "Month-end is near: start reconciliations, and confirm the filings due early next month.", { monthDay: 25 }),
      r("timesheet", "Billable Hours Log", "Log your time before you leave.", "17:45", "daily",
        "Log today's billable hours against each client before you finish."),
      r("followups", "Client Follow-Ups", "Every Monday, chase documents and payments due.", "10:00", "weekly",
        "Follow up with clients on pending documents and unpaid invoices.", { weekday: 1 }),
    ],
    actions: [
      a("Draft a Client Email", "mail", "Draft a professional email to a client asking for their pending documents."),
      a("This Week's Deadlines", "event_busy", "List the deadlines and due dates I have this week."),
      a("Summarise a Document", "description", "Summarise the latest document I saved and list the figures and dates in it."),
      a("Calculate Interest or EMI", "calculate", "Help me calculate an EMI or interest amount."),
      a("Prepare Meeting Notes", "groups", "Prepare an agenda and notes for my next client meeting."),
      a("Follow Up on Payments", "payments", "List clients with pending payments and draft polite reminders."),
    ],
  },
  {
    id: "sales",
    title: "Sales & Marketing Workspace",
    tagline: "A full pipeline, timely follow-ups and targets in view every day.",
    match: /\b(sales|marketing|business development|bd\b|account manager|growth|seo|brand|advertis|relationship manager|recruitment consultant)/i,
    focus: 60,
    day: [
      b("09:00", "09:30", "Review pipeline and today's targets", "admin"),
      b("09:30", "11:30", "Prospecting calls and messages", "focus"),
      b("11:30", "12:30", "Follow-ups on open conversations", "task"),
      b("12:30", "13:15", "Lunch break", "break"),
      b("14:00", "16:30", "Client meetings and demos", "meeting"),
      b("16:30", "17:30", "Proposals and quotations", "task"),
      b("17:30", "18:00", "Update records and plan tomorrow's call list", "admin"),
    ],
    routines: [
      r("pipeline", "Morning Pipeline Review", "Start each day with your pipeline and targets.", "09:00", "daily",
        "Review your pipeline: deals to move today, follow-ups due and how you stand against target."),
      r("followup", "Follow-Up Nudge", "A midday nudge so no lead goes cold.", "12:00", "daily",
        "Follow-up time: reply to every open lead and send the follow-ups due today."),
      r("eod", "Evening Call List", "Plan tomorrow's calls before you leave.", "17:30", "daily",
        "Update today's outcomes and prepare tomorrow's call list."),
      r("weektarget", "Weekly Target Check", "Every Monday, set the week's numbers.", "09:30", "weekly",
        "Set this week's targets and choose the five deals that matter most.", { weekday: 1 }),
    ],
    actions: [
      a("Draft a Follow-Up", "send", "Draft a short, friendly follow-up message to a prospect who has not replied."),
      a("Prepare for a Client Call", "call", "Prepare me for my next client call: their needs, likely objections and my pitch."),
      a("Write a LinkedIn Post", "campaign", "Write a professional LinkedIn post about a recent win or insight in my work."),
      a("Plan Today's Calls", "list_alt", "Plan today's calls in order of priority."),
      a("Outline a Proposal", "request_quote", "Outline a proposal for a client: problem, solution, pricing and next steps."),
      a("Summarise a Meeting", "summarize", "Summarise my last meeting and list the follow-up actions."),
    ],
  },
  {
    id: "management",
    title: "Management Workspace",
    tagline: "A team that knows its priorities, and decisions that do not wait.",
    match: /\b(manager|management|head of|director|lead|hr\b|human resources|recruiter|talent|operations|ops\b|consultant|customer support|customer success|supervisor|administrator|executive assistant)/i,
    focus: 60,
    day: [
      b("09:00", "09:30", "Inbox and approvals", "admin"),
      b("09:30", "10:00", "Team check-in", "meeting"),
      b("10:00", "12:00", "One-to-ones, interviews or client sessions", "meeting"),
      b("12:00", "13:00", "Strategic work on the top priority", "focus"),
      b("13:00", "13:45", "Lunch break", "break"),
      b("14:00", "16:00", "Decisions, reviews and escalations", "task"),
      b("17:30", "18:00", "Team update and tomorrow's priorities", "admin"),
    ],
    routines: [
      r("checkin", "Team Check-In", "A daily reminder to align the team.", "09:30", "daily",
        "Team check-in: confirm today's priorities and clear any blockers."),
      r("oneone", "One-to-One Preparation", "Every Monday, prepare the week's one-to-ones.", "09:00", "weekly",
        "Prepare this week's one-to-ones: wins, concerns and growth for each person.", { weekday: 1 }),
      r("inbox", "Inbox Clear-Down", "Clear approvals and replies before you leave.", "17:00", "daily",
        "Clear today's approvals and replies so nothing waits overnight."),
      r("weekly", "Weekly Team Report", "Every Friday, summarise the week for leadership.", "16:30", "weekly",
        "Send the weekly team report: results, risks and next week's focus.", { weekday: 5 }),
    ],
    actions: [
      a("Prepare a One-to-One", "person", "Prepare an agenda for a one-to-one with a team member."),
      a("Draft a Team Update", "campaign", "Draft a short team update on this week's progress and priorities."),
      a("Write a Job Description", "work", "Write a clear job description for a role I am hiring for."),
      a("Summarise Meeting Notes", "summarize", "Summarise my latest meeting and list owners and deadlines."),
      a("Plan My Week", "calendar_month", "Plan my week: meetings, decisions due and time for strategic work."),
      a("Draft Feedback", "rate_review", "Help me write fair, specific feedback for a team member."),
    ],
  },
  {
    id: "creative",
    title: "Creator Workspace",
    tagline: "Ideas captured, work published on time and brands followed up.",
    match: /\b(content creator|creator|influencer|youtuber|journalist|writer|author|editor|blogger|photographer|videographer|artist|musician|singer|actor|dancer|film|animator|illustrator)/i,
    focus: 120,
    day: [
      b("09:00", "10:00", "Ideas and research", "task"),
      b("10:00", "13:00", "Create: write, shoot or record", "focus"),
      b("13:00", "14:00", "Lunch break", "break"),
      b("14:00", "16:00", "Edit and review", "focus"),
      b("16:00", "17:00", "Publish and reply to your audience", "task"),
      b("17:00", "17:30", "Brand and client follow-ups", "admin"),
      b("17:30", "18:00", "Plan tomorrow's content", "admin"),
    ],
    routines: [
      r("idea", "Idea of the Day", "Each morning, capture one new idea.", "09:00", "daily",
        "Capture today's idea: one post, story or piece you could make this week."),
      r("publish", "Publishing Reminder", "Post at your best time every day.", "18:00", "daily",
        "Publishing time: post today's piece and reply to the first comments."),
      r("calendar", "Weekly Content Calendar", "Every Sunday, plan the week's content.", "18:00", "weekly",
        "Plan next week's content calendar: topics, formats and posting days.", { weekday: 0 }),
      r("brands", "Brand Follow-Ups", "Every Wednesday, chase pitches and payments.", "11:00", "weekly",
        "Follow up on brand pitches, pending deliverables and unpaid invoices.", { weekday: 3 }),
    ],
    actions: [
      a("Brainstorm Ideas", "lightbulb", "Give me ten content ideas for my audience this week."),
      a("Write a Caption", "short_text", "Write an engaging caption with relevant hashtags for my next post."),
      a("Draft a Script", "movie", "Draft a short video script with a strong opening hook."),
      a("Plan My Content Calendar", "calendar_month", "Plan my content calendar for the next two weeks."),
      a("Pitch a Brand", "handshake", "Draft a pitch email to a brand I would like to work with."),
      a("Repurpose a Piece", "autorenew", "Help me turn my latest piece into three shorter posts."),
    ],
  },
  {
    id: "healthcare_staff",
    title: "Care Team Workspace",
    tagline: "Shifts organised, handovers complete and you looked after too.",
    match: /\b(nurse|pharmacist|psycholog|counsell?or|therapist|dietitian|nutritionist|lab technician|technician lab|paramedic|caregiver|midwife|optometrist)/i,
    focus: 45,
    day: [
      b("07:30", "08:00", "Shift start: review notes and today's schedule", "admin"),
      b("08:00", "12:30", "Patients, clients or dispensing", "meeting"),
      b("12:30", "13:15", "Break and hydration", "break"),
      b("13:15", "16:30", "Appointments and documentation", "task"),
      b("16:30", "17:00", "Stock and supplies check", "task"),
      b("17:30", "18:00", "Handover notes", "admin"),
    ],
    routines: [
      r("shiftstart", "Shift-Start Checklist", "Review notes and the day's schedule before you begin.", "07:30", "daily",
        "Shift start: review handover notes and today's schedule."),
      r("break", "Break and Hydration", "A reminder to take your break.", "13:00", "daily",
        "Take your break: eat, drink water and rest for a few minutes."),
      r("stock", "Stock Check", "Check supplies or stock before the day ends.", "16:30", "daily",
        "Check supplies and stock, and note anything to reorder."),
      r("handover", "Handover Notes", "Write your handover before you leave.", "17:30", "daily",
        "Write your handover notes so the next shift has everything they need."),
    ],
    actions: [
      a("Draft Handover Notes", "assignment", "Help me structure clear handover notes for the next shift."),
      a("Plan My Shifts", "calendar_month", "Help me plan my shifts and rest days for the week."),
      a("Prepare Session Notes", "description", "Help me prepare a structure for my next client session notes."),
      a("Set a Medication Round Reminder", "alarm", "Set reminders for my medication rounds today."),
      a("Reorder List", "inventory", "Help me make a reorder list from the stock I note."),
      a("Wind Down After Shift", "self_improvement", "Guide me through a short wind-down after my shift."),
    ],
  },
  {
    id: "field_work",
    title: "On-the-Job Workspace",
    tagline: "Jobs planned, earnings logged and payments collected on time.",
    match: /\b(driver|delivery|rider|electrician|plumber|carpenter|mechanic|technician|chef|cook|tailor|painter|mason|welder|security guard|courier|farmer)/i,
    focus: 45,
    day: [
      b("07:30", "08:00", "Plan today's jobs or route", "admin"),
      b("08:00", "12:30", "Jobs and trips", "task"),
      b("12:30", "13:15", "Lunch break", "break"),
      b("13:15", "18:00", "Jobs and trips", "task"),
      b("18:00", "18:30", "Collect pending payments", "task"),
      b("21:00", "21:15", "Log today's earnings and expenses", "admin"),
    ],
    routines: [
      r("plan", "Morning Job Plan", "Plan the day's jobs or route each morning.", "07:30", "daily",
        "Plan today's jobs or route, and check you have the tools or fuel you need."),
      r("payments", "Payment Collection", "A reminder to collect what is owed.", "18:00", "daily",
        "Collect today's pending payments before you finish."),
      r("earnings", "Earnings Log", "Note today's earnings and expenses each night.", "21:00", "daily",
        "Log today's earnings and expenses."),
      r("vehicle", "Weekly Vehicle and Tool Check", "Every Sunday, check your vehicle or tools.", "10:00", "weekly",
        "Weekly check: vehicle service, tyres, fuel or tools for the week ahead.", { weekday: 0 }),
    ],
    actions: [
      a("Plan My Jobs", "route", "Plan my jobs for today in the best order."),
      a("Log Earnings", "payments", "Note today's earnings and expenses."),
      a("Remind a Customer to Pay", "send", "Draft a polite payment reminder for a customer."),
      a("Today's Weather", "wb_sunny", "What is the weather today where I am working?"),
      a("Write a Quotation", "request_quote", "Help me write a simple quotation for a job."),
      a("Set a Job Reminder", "alarm", "Set a reminder for my next job."),
    ],
  },
  {
    id: "public_service",
    title: "Public Service Workspace",
    tagline: "Duties, reports and follow-ups in order, every shift.",
    match: /\b(police|defence|defense|army|navy|air force|government|civil servant|officer|ias|ips|clerk|social worker|ngo|priest|pastor|imam|religious|pilot|cabin crew|firefighter)/i,
    focus: 60,
    day: [
      b("08:30", "09:00", "Duty briefing and today's schedule", "meeting"),
      b("09:00", "12:30", "Duties and field work", "task"),
      b("12:30", "13:15", "Lunch break", "break"),
      b("13:15", "15:30", "Cases, files and reports", "focus"),
      b("15:30", "16:30", "Follow-ups with people and departments", "task"),
      b("17:00", "17:30", "Close the day: pending items for tomorrow", "admin"),
    ],
    routines: [
      r("briefing", "Duty Briefing", "Review the day's duties every morning.", "08:30", "daily",
        "Review today's duties, schedule and anything carried over from yesterday."),
      r("reports", "Reports and Files", "A daily block for paperwork.", "14:00", "daily",
        "Reports time: update today's files and pending paperwork."),
      r("followups", "Weekly Follow-Ups", "Every Monday, list pending follow-ups.", "10:00", "weekly",
        "List this week's pending follow-ups with people and departments.", { weekday: 1 }),
      r("close", "Close the Day", "Note what carries over to tomorrow.", "17:00", "daily",
        "Close the day: note what is pending for tomorrow."),
    ],
    actions: [
      a("Draft a Report", "description", "Help me draft a clear, formal report."),
      a("Write a Formal Letter", "mail", "Help me write a formal letter or application."),
      a("Plan My Duties", "event_note", "Plan my duties for today."),
      a("Summarise a Document", "summarize", "Summarise the latest document I saved."),
      a("List Pending Follow-Ups", "checklist", "List my pending follow-ups."),
      a("Set a Duty Reminder", "alarm", "Set a reminder for my next duty."),
    ],
  },
  {
    id: "freelance",
    title: "Freelance Workspace",
    tagline: "Client work delivered, invoices sent and the next project lined up.",
    match: /\b(freelanc\w*|independent|self[- ]employed|gig|contractor)\b/i,
    focus: 120,
    day: [
      b("09:00", "09:30", "Messages and client updates", "admin"),
      b("09:30", "12:30", "Client work: the most urgent deliverable", "focus"),
      b("12:30", "13:30", "Lunch break", "break"),
      b("13:30", "16:00", "Client work: second project", "focus"),
      b("16:00", "16:45", "Pitch new clients", "task"),
      b("16:45", "17:15", "Log hours and send updates", "admin"),
    ],
    routines: [
      r("pitch", "Daily Pitch", "One new pitch every day keeps work coming.", "16:00", "daily",
        "Send one new pitch or proposal today."),
      r("hours", "Time Log", "Log hours per client every evening.", "17:00", "daily",
        "Log today's hours for each client."),
      r("invoice", "Weekly Invoicing", "Every Friday, send invoices for the week.", "15:00", "weekly",
        "Send this week's invoices and chase any that are overdue.", { weekday: 5 }),
      r("tax", "Monthly Tax Set-Aside", "On the 1st, set aside tax from last month's income.", "10:00", "monthly",
        "Set aside tax from last month's income and update your records.", { monthDay: 1 }),
    ],
    actions: [
      a("Draft a Proposal", "request_quote", "Draft a proposal for a new client: scope, timeline and price."),
      a("Write a Client Update", "mail", "Write a short progress update for my client."),
      a("Chase an Invoice", "payments", "Draft a polite reminder for an overdue invoice."),
      a("Plan My Week", "calendar_month", "Plan my week across my client projects."),
      a("Estimate a Project", "timer", "Help me estimate the hours and price for a project."),
      a("Find Leads", "travel_explore", "Suggest where I can find new clients for my kind of work."),
    ],
  },
  {
    id: "student",
    title: "Student Workspace",
    tagline: "A study plan you keep, assignments on time and exams prepared.",
    match: /\b(student|aspirant|upsc|neet|jee|gate|cat\b|exam|studying|intern)/i,
    focus: 50,
    day: [
      b("07:00", "07:30", "Review today's timetable and goals", "admin"),
      b("08:00", "14:00", "Classes and lectures", "meeting"),
      b("14:00", "15:00", "Lunch and rest", "break"),
      b("16:00", "17:30", "Assignments and homework", "focus"),
      b("17:30", "18:30", "Exercise or a break outdoors", "personal"),
      b("19:00", "21:00", "Revision and practice questions", "focus"),
    ],
    routines: [
      r("plan", "Morning Study Plan", "Choose today's study goals every morning.", "07:00", "daily",
        "Plan today's study: the subjects, chapters and practice you will cover."),
      r("assign", "Assignment Check", "Check what is due before the evening.", "16:00", "daily",
        "Check your assignments and homework due this week."),
      r("revise", "Evening Revision", "A daily revision block.", "19:00", "daily",
        "Revision time: review today's topics and solve practice questions."),
      r("mock", "Weekly Mock Test", "Every Sunday, take a timed practice test.", "10:00", "weekly",
        "Take a timed mock test and note the topics to revise.", { weekday: 0 }),
    ],
    actions: [
      a("Make a Study Timetable", "calendar_month", "Make a weekly study timetable for my subjects and exams."),
      a("Explain a Topic", "lightbulb", "Explain a topic I am studying simply, with an example."),
      a("Quiz Me", "quiz", "Quiz me with ten questions on the topic I am studying."),
      a("Summarise My Notes", "summarize", "Summarise my latest notes into key points."),
      a("Plan Exam Revision", "event_note", "Plan my revision for my upcoming exams."),
      a("Track Assignments", "checklist", "Remind me which assignments are due this week."),
    ],
  },
  {
    id: "homemaker",
    title: "Home Workspace",
    tagline: "Meals, bills and the family's day, all organised.",
    match: /\b(home ?maker|house ?wife|house ?husband|stay[- ]at[- ]home|parent)\b/i,
    focus: 30,
    day: [
      b("06:30", "07:30", "Breakfast and school preparation", "personal"),
      b("09:00", "10:00", "Groceries and errands", "task"),
      b("10:00", "11:00", "Bills, payments and paperwork", "admin"),
      b("12:30", "13:30", "Lunch", "break"),
      b("16:00", "17:00", "Children's homework and activities", "personal"),
      b("19:30", "20:00", "Plan tomorrow's meals and tasks", "admin"),
    ],
    routines: [
      r("mealplan", "Weekly Meal Plan", "Every Sunday, plan the week's meals and groceries.", "17:00", "weekly",
        "Plan this week's meals and make the grocery list.", { weekday: 0 }),
      r("bills", "Monthly Bills", "On the 5th, check bills and payments due.", "10:00", "monthly",
        "Check this month's bills: electricity, phone, internet, rent and school fees.", { monthDay: 5 }),
      r("school", "School Morning", "A reminder for the school morning.", "06:30", "daily",
        "School morning: lunch boxes, uniforms and bags."),
      r("tomorrow", "Tomorrow's Plan", "Plan meals and tasks each evening.", "19:30", "daily",
        "Plan tomorrow's meals and tasks."),
    ],
    actions: [
      a("Plan This Week's Meals", "restaurant_menu", "Plan healthy meals for this week and make a grocery list."),
      a("Make a Grocery List", "shopping_cart", "Make my grocery list for this week."),
      a("Bills Due", "receipt_long", "Which bills are due this month?"),
      a("Family Schedule", "family_restroom", "Help me organise the family's schedule for this week."),
      a("Quick Recipe", "soup_kitchen", "Suggest a quick recipe with what I have at home."),
      a("Set a Reminder", "alarm", "Set a reminder for me."),
    ],
  },
  {
    id: "retired",
    title: "Wellbeing Workspace",
    tagline: "Health, family and the things you enjoy, every day.",
    match: /\b(retired|pensioner|senior)\b/i,
    focus: 30,
    day: [
      b("07:00", "07:45", "Morning walk or yoga", "personal"),
      b("08:00", "08:15", "Morning medicines", "personal"),
      b("10:00", "11:30", "Reading, news or a hobby", "personal"),
      b("13:00", "14:00", "Lunch and rest", "break"),
      b("17:30", "18:15", "Evening walk", "personal"),
      b("19:00", "19:30", "Call family or friends", "personal"),
    ],
    routines: [
      r("meds", "Morning Medicines", "Never miss the morning dose.", "08:00", "daily",
        "Time for your morning medicines."),
      r("walk", "Evening Walk", "A gentle daily walk.", "17:30", "daily",
        "Time for your evening walk."),
      r("family", "Weekly Family Call", "Every Sunday, call someone you love.", "11:00", "weekly",
        "Call your family or an old friend today.", { weekday: 0 }),
      r("checkup", "Monthly Health Check", "On the 1st, check blood pressure and sugar.", "09:00", "monthly",
        "Monthly health check: blood pressure, sugar, and refill your medicines.", { monthDay: 1 }),
    ],
    actions: [
      a("Read Me the News", "newspaper", "Read me today's main news."),
      a("Medicine Reminders", "medication", "Set reminders for my daily medicines."),
      a("Call My Family", "call", "Help me call my family."),
      a("A Gentle Exercise", "self_improvement", "Guide me through a gentle ten-minute exercise."),
      a("Today's Weather", "wb_sunny", "What is the weather today?"),
      a("Pension and Bills", "receipt_long", "Which bills or pension dates are coming up?"),
    ],
  },
  {
    id: "job_seeker",
    title: "Career Workspace",
    tagline: "Applications every day, skills growing and interviews prepared.",
    match: /\b(looking for work|job ?seeker|unemployed|between jobs|fresher)\b/i,
    focus: 60,
    day: [
      b("09:00", "10:00", "Find and shortlist openings", "task"),
      b("10:00", "11:30", "Tailor and send applications", "focus"),
      b("12:30", "13:30", "Lunch break", "break"),
      b("14:00", "15:30", "Learn a skill", "focus"),
      b("16:00", "16:30", "Networking messages", "task"),
      b("17:00", "17:30", "Interview practice", "task"),
    ],
    routines: [
      r("apply", "Daily Applications", "Apply to three suitable roles each day.", "10:00", "daily",
        "Apply to three suitable roles today, each with a tailored message."),
      r("skill", "Skill Hour", "One hour of learning every afternoon.", "14:00", "daily",
        "Skill hour: one focused hour of learning."),
      r("network", "Weekly Networking", "Every Wednesday, reach out to five people.", "16:00", "weekly",
        "Reach out to five people in your field this week.", { weekday: 3 }),
      r("review", "Weekly Review", "Every Friday, review applications and replies.", "17:00", "weekly",
        "Review this week's applications, replies and next steps.", { weekday: 5 }),
    ],
    actions: [
      a("Improve My CV", "description", "Help me improve my CV for the roles I am applying to."),
      a("Write a Cover Letter", "mail", "Write a tailored cover letter for a role."),
      a("Mock Interview", "record_voice_over", "Give me a mock interview for my target role."),
      a("Plan My Job Search", "event_note", "Plan my job search for this week."),
      a("Networking Message", "send", "Draft a short networking message to someone in my field."),
      a("Learn a Skill", "school", "Suggest a two-week plan to learn a skill employers want."),
    ],
  },
  {
    id: "general",
    title: "Professional Workspace",
    tagline: "Your day planned, priorities clear and routine work automated.",
    match: null,
    focus: 60,
    day: [
      b("09:00", "09:30", "Messages and today's plan", "admin"),
      b("09:30", "12:30", "Focused work on the top priority", "focus"),
      b("12:30", "13:30", "Lunch break", "break"),
      b("14:00", "16:00", "Meetings and collaboration", "meeting"),
      b("16:00", "17:30", "Second focus block", "focus"),
      b("17:30", "18:00", "Wrap up and plan tomorrow", "admin"),
    ],
    routines: [
      r("plan", "Morning Plan", "Choose today's top three every morning.", "09:00", "daily",
        "Plan your day: choose today's top three priorities."),
      r("focus", "Focus Block", "Protect time for your most important work.", "10:00", "daily",
        "Focus time: start your most important task."),
      r("wrapup", "End-of-Day Wrap-Up", "Close the day with tomorrow planned.", "17:30", "daily",
        "Wrap up: note what you finished and plan tomorrow."),
      r("weekly", "Weekly Review", "Every Friday, review the week.", "16:30", "weekly",
        "Weekly review: what went well, what is pending and next week's priorities.", { weekday: 5 }),
    ],
    actions: [
      a("Plan My Day", "event_note", "Plan my day around my meetings and top priorities."),
      a("Draft an Email", "mail", "Help me draft a professional email."),
      a("Summarise a Document", "summarize", "Summarise the latest document I saved."),
      a("Prepare My Next Meeting", "groups", "Prepare me for my next meeting."),
      a("Weekly Review", "insights", "Help me review my week and plan the next one."),
      a("Set a Reminder", "alarm", "Set a reminder for me."),
    ],
  },
  {
    id: "personal",
    title: "Personal Workspace",
    tagline: "Your day, your errands and your habits, organised.",
    match: null,
    focus: 30,
    day: [
      b("07:00", "07:30", "Morning routine", "personal"),
      b("09:00", "10:00", "Errands and appointments", "task"),
      b("13:00", "14:00", "Lunch", "break"),
      b("18:00", "18:45", "Exercise", "personal"),
      b("21:00", "21:15", "Plan tomorrow", "admin"),
    ],
    routines: [
      r("morning", "Morning Plan", "Start each day with a plan.", "08:00", "daily",
        "Good morning. Choose today's top three things to do."),
      r("exercise", "Exercise", "A daily reminder to move.", "18:00", "daily",
        "Time to exercise: a walk, a workout or yoga."),
      r("bills", "Monthly Bills", "On the 5th, check bills due.", "10:00", "monthly",
        "Check this month's bills and payments due.", { monthDay: 5 }),
      r("weekly", "Weekly Plan", "Every Sunday, plan the week ahead.", "18:00", "weekly",
        "Plan the week ahead: appointments, errands and goals.", { weekday: 0 }),
    ],
    actions: [
      a("Plan My Day", "event_note", "Plan my day."),
      a("Make a To-Do List", "checklist", "Make a to-do list for today."),
      a("Bills Due", "receipt_long", "Which bills are due this month?"),
      a("Set a Reminder", "alarm", "Set a reminder for me."),
      a("Book Something", "event_available", "Help me book an appointment."),
      a("Today's Weather", "wb_sunny", "What is the weather today?"),
    ],
  },
];

const BY_ID = new Map(PACKS.map((p) => [p.id, p]));
const PERSONA_DEFAULT = { student: "student", personal: "personal", professional: "general" };

/** The pack for a user: their own words first, then their persona. */
function packFor({ profession = "", persona = "" } = {}) {
  const text = String(profession || "").trim();
  if (text) {
    // The specific families first; student/home/retired are matched too, so
    // "retired banker" lands on wellbeing, not finance.
    for (const id of ["student", "retired", "job_seeker", "homemaker"]) {
      if (BY_ID.get(id).match.test(text)) return BY_ID.get(id);
    }
    for (const p of PACKS) {
      if (p.match && p.match.test(text)) return p;
    }
  }
  return BY_ID.get(PERSONA_DEFAULT[persona] || "general");
}

function get(id) {
  return BY_ID.get(String(id || "")) || null;
}

/** What the app receives: everything except the matcher. */
function toClient(p) {
  const { match, ...rest } = p;
  return rest;
}

module.exports = { PACKS, packFor, get, toClient };
