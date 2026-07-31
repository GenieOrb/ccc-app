import { generateDeterministicSlotPlans } from '../src/lib/planner';
import { validateCommentLocally } from '../src/lib/validator';
import { SlotPlanV2 } from '../src/lib/brand-variants';

function runTests() {
  console.log('--- Testing Deterministic Planner ---');

  const postId = 'test-post-1';
  const brandVariants = [
    { value: 'GenieOrb', percentage: 70 }, // 7000
    { value: 'Genie', percentage: 30 }     // 3000
  ];

  const plans = generateDeterministicSlotPlans([postId], 50, brandVariants);

  console.log(`Generated ${plans.length} plans.`);

  // Verify distribution
  let genieOrbCount = 0;
  let genieCount = 0;

  for (const plan of plans) {
    if (plan.brandVariant === 'GenieOrb') genieOrbCount++;
    if (plan.brandVariant === 'Genie') genieCount++;
  }

  console.log(`GenieOrb Count: ${genieOrbCount} (Expected: 35)`);
  console.log(`Genie Count: ${genieCount} (Expected: 15)`);

  // Test Validator
  console.log('\n--- Testing Validator ---');
  const plan: SlotPlanV2 = {
    version: 2,
    slotIndex: 0,
    assignedPostId: postId,
    deliveryOrder: 0,
    firstPersonSubfamily: 'personal_preference',
    emotionalTone: 'neutral',
    expressionMode: 'standard',
    lengthMode: 'normal',
    emojiPolicy: 'one_emoji',
    rhetoricalForm: 'direct_reaction',
    texture: 'warm',
    voiceFamily: 'first_person',
    punctuationMode: 'no_punctuation',
    capitalizationMode: 'lowercase_only',
    syntaxMode: 'line_breaks',
    brandVariant: 'GenieOrb'
  };

  const validComment = "i love GenieOrb\nits the best \u2764"; // Note: \u2764 is red heart emoji
  const result = validateCommentLocally(validComment, plan);
  console.log('Valid comment validation:', result);

  const invalidComment = "I love GenieOrb\nits the best \u2764"; // Uppercase 'I'
  const invalidResult = validateCommentLocally(invalidComment, plan);
  console.log('Invalid comment (uppercase):', invalidResult);

  const invalidComment2 = "i love Genie\nits the best \u2764"; // Wrong brand
  const invalidResult2 = validateCommentLocally(invalidComment2, plan);
  console.log('Invalid comment (wrong brand):', invalidResult2);

  const invalidComment3 = "i love GenieOrb, its the best \u2764\n"; // Punctuation comma
  const invalidResult3 = validateCommentLocally(invalidComment3, plan);
  console.log('Invalid comment (punctuation):', invalidResult3);
}

runTests();
