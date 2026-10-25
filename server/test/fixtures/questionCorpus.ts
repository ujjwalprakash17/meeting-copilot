/**
 * Labelled utterances for question/request detection.
 *
 *  - expect "answer": the heuristics alone accept it (an answer is generated immediately).
 *  - expect "classifier": too uncertain for the heuristics alone; sent to the small LLM classifier with context.
 *  - expect "ignore": no answer and no classifier call.
 *
 * "dev" items come from the requirements and were used while building the heuristics. "holdout" items were
 * written before the implementation and are reported separately (same author, so not an independent set).
 */
import type { RequestIntent } from '../../src/detection/scoring.js';

export type Expectation = 'answer' | 'classifier' | 'ignore';

export interface LabelledUtterance {
  text: string;
  expect: Expectation;
  intent?: RequestIntent;
  requiresContext?: boolean;
  set: 'dev' | 'holdout';
  category: string;
}

type Row = [text: string, expect: Expectation, intent?: RequestIntent, requiresContext?: boolean];

const rows = (category: string, set: 'dev' | 'holdout', items: Row[]): LabelledUtterance[] =>
  items.map(([text, expect, intent, requiresContext]) => ({
    text,
    expect,
    ...(intent ? { intent } : {}),
    ...(requiresContext !== undefined ? { requiresContext } : {}),
    set,
    category,
  }));

export const CORPUS: LabelledUtterance[] = [
  // A. Direct interrogative questions
  ...rows('direct', 'dev', [
    ['What is your role?', 'answer', 'direct_question', false],
    ['Why did you choose React?', 'answer', 'direct_question', false],
    ['How would you optimize this query?', 'answer', 'direct_question', true],
    ['Where did you study?', 'answer', 'direct_question', false],
    ['Have you worked with Kafka?', 'answer', 'direct_question', false],
    ['what is your notice period', 'answer', 'direct_question', false],
    ['Do you have experience with Kubernetes', 'answer', 'direct_question', false],
  ]),
  ...rows('direct', 'holdout', [
    ['Which cloud provider have you used the most?', 'answer', 'direct_question', false],
    ['How many people were on your team?', 'answer', 'direct_question', false],
    ['why did you leave your last job', 'answer', 'direct_question', false],
    ['Is there anything you would do differently now?', 'answer', 'direct_question', false],
    ['When did you first start programming?', 'answer', 'direct_question', false],
  ]),

  // B. Imperative requests and instructions
  ...rows('imperative', 'dev', [
    ['Give the name of your dog.', 'answer', 'imperative_request', false],
    ['give the name of your dog', 'answer', 'imperative_request', false],
    ['Tell me about yourself.', 'answer', 'imperative_request', false],
    ['Describe your most challenging project.', 'answer', 'imperative_request', false],
    ['Explain how you solved that problem.', 'answer', 'imperative_request', true],
    ['Walk me through your system design.', 'answer', 'imperative_request', false],
    ['Share an example of a time you handled a conflict.', 'answer', 'imperative_request', false],
    ['Name three technologies you use regularly.', 'answer', 'imperative_request', false],
    ['List the steps you would take to debug this issue.', 'answer', 'imperative_request', true],
    ['Summarize your previous work experience.', 'answer', 'imperative_request', false],
    ['Briefly introduce yourself.', 'answer', 'imperative_request', false],
    ['Talk about a difficult technical decision you made.', 'answer', 'imperative_request', false],
    ['Demonstrate how you would approach this problem.', 'answer', 'imperative_request', true],
    ['Tell me about your last project.', 'answer', 'imperative_request', false],
    ['Explain the difference between threads and processes.', 'answer', 'imperative_request', false],
    ['Describe your debugging process.', 'answer', 'imperative_request', false],
    ['List the trade-offs of this approach.', 'answer', 'imperative_request', true],
    ['Show me how you would implement this.', 'answer', 'imperative_request', true],
    ['Walk me through the solution.', 'answer', 'imperative_request', false],
    ['Compare SQL and NoSQL.', 'answer', 'imperative_request', false],
    ['Calculate the time complexity.', 'answer', 'imperative_request', false],
    ['Write a function that reverses a linked list.', 'answer', 'imperative_request', false],
    ['Please describe the architecture.', 'answer', 'imperative_request', false],
  ]),
  ...rows('imperative', 'holdout', [
    ['Define polymorphism.', 'answer', 'imperative_request', false],
    ['Outline your approach to migrating a monolith.', 'answer', 'imperative_request', false],
    ['Give me an overview of your current team.', 'answer', 'imperative_request', false],
    ['Estimate how many requests per second this service can handle.', 'answer', 'imperative_request', true],
    ['Implement a function to check whether a string is a palindrome.', 'answer', 'imperative_request', false],
    ['Design a rate limiter for a public API.', 'answer', 'imperative_request', false],
    ['Go over the main responsibilities in your last role.', 'answer', 'imperative_request', false],
    ['Run me through your typical day.', 'answer', 'imperative_request', false],
    ['explain closures in javascript', 'answer', 'imperative_request', false],
    ['describe a time you disagreed with your manager', 'answer', 'imperative_request', false],
    ['Please list your top three strengths.', 'answer', 'imperative_request', false],
    ['Quickly summarize the project for me.', 'answer', 'imperative_request', false],
    ['Okay, first, tell me what you know about our company.', 'answer', 'imperative_request', false],
    ['Name a design pattern you have used recently.', 'answer', 'imperative_request', false],
    ['Show us how the data flows through the system.', 'answer', 'imperative_request', false],
    ['Break down the problem into smaller parts.', 'answer', 'imperative_request', false],
    ['Clarify what you meant by eventual consistency.', 'answer', 'imperative_request', false],
    ['Justify your choice of database.', 'answer', 'imperative_request', false],
    ['Recommend a caching strategy for this workload.', 'answer', 'imperative_request', true],
    ['Sell me this pen.', 'answer', 'imperative_request', true],
    ['Help me understand why you chose microservices.', 'answer', 'imperative_request', false],
  ]),

  // C. Indirect and polite requests
  ...rows('indirect', 'dev', [
    ["I'd like you to introduce yourself.", 'answer', 'indirect_request', false],
    ['Could you walk me through your experience?', 'answer', 'indirect_request', false],
    ['I want to understand how you handled that incident.', 'answer', 'indirect_request', true],
    ['It would be helpful if you could explain your approach.', 'answer', 'indirect_request', false],
    ['Would you mind explaining your reasoning?', 'answer', 'indirect_request', false],
    ["I'd like you to explain your role in that project.", 'answer', 'indirect_request', true],
    ["Let's discuss your experience with distributed systems.", 'answer', 'indirect_request', false],
    ['Can you explain dependency injection?', 'answer', 'indirect_request', false],
  ]),
  ...rows('indirect', 'holdout', [
    ["I'm curious how you approached testing on that team.", 'answer', 'indirect_request', true],
    ['I would love for you to tell me about your biggest win.', 'answer', 'indirect_request', false],
    ['I need you to explain the trade-offs here.', 'answer', 'indirect_request', false],
    ['It would be great to hear about your leadership style.', 'answer', 'indirect_request', false],
    ["I'm interested in hearing about your experience with Go.", 'answer', 'indirect_request', false],
    ['Could you maybe talk a little about your background', 'answer', 'indirect_request', false],
    ['Can you briefly describe your current project?', 'answer', 'indirect_request', false],
    ["Let's talk about your time at Acme.", 'answer', 'indirect_request', false],
    ['I want to hear how you would scale this service.', 'answer', 'indirect_request', true],
  ]),

  // D. Elliptical and conversational questions
  ...rows('elliptical', 'dev', [
    ['Your biggest technical challenge?', 'answer', 'elliptical', false],
    ['The reason behind that choice?', 'answer', 'elliptical', true],
    ['And your role in that project?', 'answer', 'elliptical', true],
    ['What about scalability?', 'answer', 'elliptical', true],
    ['How about the edge cases?', 'answer', 'elliptical', true],
    ['Your approach to testing?', 'answer', 'elliptical', false],
    ['Your approach to database scaling?', 'answer', 'elliptical', false],
    ['And the reason for choosing that architecture?', 'answer', 'elliptical', true],
    ['Your biggest weakness?', 'answer', 'elliptical', false],
    ['What about a situation where the requirements keep changing?', 'answer', 'elliptical', true],
  ]),
  ...rows('elliptical', 'holdout', [
    ['Your salary expectations?', 'answer', 'elliptical', false],
    ['And the timeline for that?', 'answer', 'elliptical', true],
    ['Your thoughts on TypeScript?', 'answer', 'elliptical', false],
    ['Any experience with GraphQL?', 'answer', 'elliptical', false],
    ['Your biggest weakness', 'classifier', 'elliptical', false],
    ['your approach to testing', 'classifier', 'elliptical', false],
  ]),

  // E. Hypothetical and scenario-based questions
  ...rows('hypothetical', 'dev', [
    ['Suppose the database goes down. What would you do?', 'answer', 'hypothetical', false],
    ['Suppose we have a million records. How would you handle them?', 'answer', 'hypothetical', false],
    ['Imagine traffic increases tenfold.', 'classifier', 'hypothetical', false],
    ["Let's say the service receives a million requests per minute.", 'classifier', 'hypothetical', false],
    ['Consider a system with multiple writers.', 'classifier', 'hypothetical', false],
    ['Assume the cache is unavailable.', 'classifier', 'hypothetical', false],
  ]),
  ...rows('hypothetical', 'holdout', [
    ['Imagine you join a team with no tests. Where would you start?', 'answer', 'hypothetical', false],
    ['What if the network partitions during a write?', 'answer', 'hypothetical', false],
    ['Say you have two services writing to the same table. How do you keep them consistent?', 'answer', 'hypothetical', false],
    ['Assume a user reports slow page loads. Walk me through your investigation.', 'answer', 'hypothetical', false],
    ['Picture a queue that keeps growing.', 'classifier', 'hypothetical', false],
  ]),

  // F. Follow-up questions and requests
  ...rows('follow_up', 'dev', [
    ['Can you elaborate?', 'answer', 'follow_up', true],
    ['Give me another example.', 'answer', 'follow_up', true],
    ['Why did you do that?', 'answer', 'follow_up', true],
    ['Explain that decision in more detail.', 'answer', 'follow_up', true],
    ['What happened next?', 'answer', 'follow_up', true],
    ['Can you make that more concrete?', 'answer', 'follow_up', true],
    ['Could you elaborate on that?', 'answer', 'follow_up', true],
  ]),
  ...rows('follow_up', 'holdout', [
    ['Elaborate.', 'answer', 'follow_up', true],
    ['Tell me more about that.', 'answer', 'follow_up', true],
    ['Why is that?', 'answer', 'follow_up', true],
    ['How so?', 'answer', 'follow_up', true],
    ['Expand on the caching part.', 'answer', 'follow_up', true],
    ['And then what?', 'answer', 'follow_up', true],
    ['Say more about that.', 'answer', 'follow_up', true],
  ]),

  // Statements that mention requests or question words: no answer.
  ...rows('statement', 'dev', [
    ['I gave the name of my dog yesterday.', 'ignore'],
    ['We discussed the architecture in the last meeting.', 'ignore'],
    ['I usually use React for frontend development.', 'ignore'],
    ['The interviewer asked me about database indexes.', 'ignore'],
    ['Let me explain what happened.', 'ignore'],
    ['I am going to describe my previous project now.', 'ignore'],
    ['Thanks for explaining that.', 'ignore'],
    ['That is a good answer.', 'ignore'],
    ['I will give you the name of the dog later.', 'ignore'],
    ['I want to tell you about my project.', 'ignore'],
    ['I could explain this.', 'ignore'],
  ]),
  ...rows('statement', 'holdout', [
    ['We used Kafka for the event pipeline.', 'ignore'],
    ["My dog's name is Bruno.", 'ignore'],
    ['He explained the design really well.', 'ignore'],
    ['She told me about the reorg last week.', 'ignore'],
    ['Our team described the incident in the postmortem.', 'ignore'],
    ['The candidate listed three technologies.', 'ignore'],
    ["I'll walk you through the agenda first.", 'ignore'],
    ['Let me give you some context about the role.', 'ignore'],
    ["I'm going to explain how the interview works.", 'ignore'],
    ['Thanks, that was really helpful.', 'ignore'],
    ['Great, that answers my question.', 'ignore'],
    ['That makes sense.', 'ignore'],
    ['Interesting approach.', 'ignore'],
    ["Okay, let's move on.", 'ignore'],
    ['We can discuss salary in the next round.', 'ignore'],
    ['You can tell me about it later.', 'ignore'],
    ['Name tags are at the front desk.', 'ignore'],
    ['Explaining it took a while.', 'ignore'],
    ['Describing the system is hard without a diagram.', 'ignore'],
  ]),

  // Meeting logistics, audio checks and rhetorical tags: no answer.
  ...rows('logistics', 'dev', [
    ['Can you hear me okay?', 'ignore'],
    ['Does that make sense?', 'ignore'],
    ["That's the plan for the sprint, right?", 'ignore'],
    ['Okay.', 'ignore'],
  ]),
  ...rows('logistics', 'holdout', [
    ['Can you see my screen?', 'ignore'],
    ['Give me a second to pull up the doc.', 'ignore'],
    ["Share your screen when you're ready.", 'ignore'],
    ["Tell me when you're ready.", 'ignore'],
    ['Let me know if you have any questions.', 'ignore'],
    ['Take your time.', 'ignore'],
    ['Go ahead.', 'ignore'],
    ['Sorry, could you repeat that?', 'ignore'],
    ['Let me share my screen.', 'ignore'],
  ]),

  // Incomplete fragments (e.g. flushed by the debounce mid-sentence): no answer.
  ...rows('fragment', 'dev', [
    ['So the', 'ignore'],
    ['And', 'ignore'],
    ['Explain the', 'ignore'],
    ['The database', 'ignore'],
  ]),
  ...rows('fragment', 'holdout', [
    ['Okay so basically', 'ignore'],
    ['Tell me about the', 'ignore'],
  ]),
];
