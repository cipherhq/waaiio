export interface WaiverTemplate {
  id: string;
  name: string;
  category: string;
  content: string;
}

export const WAIVER_TEMPLATES: WaiverTemplate[] = [
  {
    id: 'fitness',
    name: 'Fitness & Gym Liability Waiver',
    category: 'fitness',
    content: `LIABILITY WAIVER AND RELEASE

I, the undersigned, acknowledge that I am voluntarily participating in physical fitness activities at {{business_name}}.

I understand that physical exercise involves risk of injury, including but not limited to: muscle strains, sprains, fractures, cardiovascular events, and other physical injuries. I assume full responsibility for any risks, injuries, or damages that may occur during my participation.

I hereby release {{business_name}}, its owners, employees, trainers, and agents from any and all liability, claims, or demands arising from my use of the facilities, equipment, or participation in any fitness programs.

I confirm that I am physically fit and have no medical condition that would prevent me from safely participating in physical activities. I agree to inform staff immediately if I feel unwell during any activity.

This waiver is effective from {{date}} and remains valid for the duration of my membership or participation.`,
  },
  {
    id: 'salon-spa',
    name: 'Salon & Spa Treatment Waiver',
    category: 'salon',
    content: `TREATMENT CONSENT AND LIABILITY WAIVER

I, the undersigned, consent to receive beauty, grooming, or spa treatments at {{business_name}}.

I understand that treatments may involve chemicals, heat, sharp instruments, or other tools that carry inherent risks including but not limited to: allergic reactions, skin irritation, burns, cuts, or infection.

I confirm that I have disclosed all known allergies, skin conditions, medical conditions, and medications to my service provider. I understand that failure to disclose relevant information may increase the risk of adverse reactions.

I agree that {{business_name}} and its staff are not liable for any adverse reactions or outcomes resulting from treatments performed with my consent, provided reasonable care was taken.

I understand that results may vary and are not guaranteed. I have had the opportunity to ask questions about my treatment and am satisfied with the information provided.

This waiver is effective from {{date}}.`,
  },
  {
    id: 'tattoo',
    name: 'Tattoo & Body Art Consent',
    category: 'tattoo',
    content: `TATTOO/BODY ART CONSENT AND RELEASE

I, the undersigned, hereby request and consent to the application of a tattoo or body art procedure by {{business_name}}.

I acknowledge that a tattoo is a permanent change to my appearance. I understand the procedure involves penetrating the skin with needles, which carries risks including but not limited to: infection, scarring, allergic reactions, keloid formation, and dissatisfaction with results.

I confirm that I am at least 18 years of age (or have legal guardian consent). I am not under the influence of alcohol or drugs. I do not have any medical conditions that may affect healing including but not limited to: diabetes, hemophilia, heart conditions, or autoimmune disorders (or I have disclosed them to my artist).

I agree to follow all aftercare instructions provided. I understand that improper aftercare may result in infection or damage to the tattoo.

I release {{business_name}}, its artists and staff from any liability for outcomes of the procedure, provided it was performed with reasonable care and hygiene standards.

This consent is effective as of {{date}}.`,
  },
  {
    id: 'adventure',
    name: 'Adventure & Sports Activity Waiver',
    category: 'adventure',
    content: `ASSUMPTION OF RISK AND WAIVER OF LIABILITY

I, the undersigned, voluntarily choose to participate in recreational/adventure activities offered by {{business_name}}.

I acknowledge that these activities involve inherent risks and dangers including but not limited to: falls, collisions, drowning, equipment failure, weather conditions, animal encounters, and other hazards that may result in injury, disability, or death.

I assume full responsibility for any and all risks associated with my participation. I confirm that I am in good physical health and have no conditions that would make participation inadvisable.

I agree to follow all safety instructions, rules, and guidelines provided by {{business_name}} and its staff. I understand that failure to follow instructions may increase the risk of injury and void this waiver.

I hereby release {{business_name}}, its owners, employees, guides, and agents from any liability, claims, or legal action arising from my participation, except in cases of gross negligence.

This waiver is effective from {{date}} for the duration of my participation.`,
  },
  {
    id: 'medical',
    name: 'Medical/Health Treatment Consent',
    category: 'healthcare',
    content: `INFORMED CONSENT AND WAIVER

I, the undersigned, consent to receive health, wellness, or medical-related services from {{business_name}}.

I understand that the services provided are not a substitute for licensed medical care unless performed by a licensed practitioner. I have disclosed my complete medical history, current medications, and any conditions that may affect treatment.

I understand that any treatment carries risks including but not limited to: discomfort, bruising, allergic reaction, or worsening of symptoms. The expected benefits and potential risks have been explained to me.

I authorize {{business_name}} to perform the agreed-upon treatment and to take reasonable steps in the event of an emergency. I understand that I may withdraw my consent at any time.

I release {{business_name}} and its practitioners from liability for outcomes that may arise from treatment, provided reasonable professional standards of care were followed.

This consent is effective from {{date}}.`,
  },
  {
    id: 'event',
    name: 'Event Participation Waiver',
    category: 'event',
    content: `EVENT PARTICIPATION WAIVER AND RELEASE

I, the undersigned, voluntarily agree to participate in event(s) hosted by {{business_name}}.

I acknowledge that participation in events may involve physical activity, crowded spaces, loud noise, and other conditions that could pose risks to health and safety.

I assume full responsibility for my personal belongings and for any injury or loss that may occur during the event, except where caused by the organizer's gross negligence.

I consent to being photographed, filmed, or recorded during the event, and grant {{business_name}} the right to use such media for promotional purposes unless I notify the organizer in writing beforehand.

I agree to follow all event rules, venue policies, and instructions from event staff. I understand that violation of these rules may result in removal from the event without refund.

I release {{business_name}}, its organizers, sponsors, and venue from any claims arising from my participation.

This waiver is effective from {{date}}.`,
  },
  {
    id: 'property',
    name: 'Property Viewing / Short-Let Waiver',
    category: 'real_estate',
    content: `PROPERTY ACCESS AND LIABILITY WAIVER

I, the undersigned, acknowledge that I am voluntarily entering or staying at a property managed by {{business_name}}.

I understand that the property may contain hazards including but not limited to: uneven surfaces, stairs, swimming pools, electrical installations, and other features that may pose a risk of injury.

I agree to use the property responsibly and in accordance with any rules or guidelines provided. I accept liability for any damage I cause to the property or its contents during my visit or stay.

I release {{business_name}}, the property owner, and their agents from any claims arising from injury or loss during my visit, except where caused by gross negligence or failure to maintain safe conditions.

This waiver is effective from {{date}}.`,
  },
  {
    id: 'general',
    name: 'General Liability Waiver',
    category: 'general',
    content: `LIABILITY WAIVER AND RELEASE

I, the undersigned, acknowledge that I am voluntarily engaging with the services, facilities, or activities offered by {{business_name}}.

I understand that participation may involve certain risks, and I accept full responsibility for any injury, loss, or damage that may occur during my engagement, except where caused by gross negligence.

I have been given the opportunity to ask questions and am satisfied with the information provided. I confirm that I have disclosed any relevant medical conditions or limitations.

I hereby release {{business_name}}, its owners, employees, and agents from any and all claims, demands, or liability arising from my participation.

This waiver is effective from {{date}}.`,
  },
];

/** Fill placeholders in waiver template content */
export function fillWaiverPlaceholders(
  content: string,
  values: Record<string, string>
): string {
  let result = content;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}
