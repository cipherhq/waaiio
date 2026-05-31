export interface TemplateQuestion {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox' | 'radio' | 'checkbox-group';
  placeholder?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
  defaultValue?: string;
  group?: string;
  /** Only show this question when condition is met */
  showWhen?: { questionId: string; value: string };
}

export interface ContractTemplate {
  id: string;
  name: string;
  category: string;
  content: string;
  questions?: TemplateQuestion[];
}

/** Questions common to all built-in templates */
export const COMMON_QUESTIONS: TemplateQuestion[] = [
  { id: 'business_name', label: 'Business Name', type: 'text', placeholder: 'Your business name', required: true, group: 'Parties' },
  { id: 'signer_name', label: 'Signer Name', type: 'text', placeholder: 'Name of the person signing', group: 'Parties' },
  { id: 'effective_date', label: 'Effective Date', type: 'date', required: true, group: 'Parties' },
  { id: 'governing_jurisdiction', label: 'Governing Jurisdiction/State', type: 'text', placeholder: 'e.g. State of Maryland', group: 'Parties' },
];

export const CONTRACT_TEMPLATES: ContractTemplate[] = [
  {
    id: 'service-agreement',
    name: 'Service Agreement',
    category: 'general',
    content: `SERVICE AGREEMENT

This Service Agreement ("Agreement") is entered into as of {{date}}, by and between:

Service Provider: {{business_name}}
Client: {{signer_name}}

1. SCOPE OF SERVICES
The Service Provider agrees to provide the following services to the Client as described and agreed upon by both parties. The specific deliverables, timelines, and requirements shall be as mutually agreed in writing.

2. COMPENSATION
The Client agrees to pay the Service Provider the agreed-upon fee for services rendered. Payment terms, amounts, and schedules shall be as agreed between the parties prior to commencement of services.

3. TERM AND TERMINATION
This Agreement shall commence on the date first written above and shall continue until the services are completed or until terminated by either party with 14 days written notice. Either party may terminate this Agreement immediately in the event of a material breach by the other party.

4. INDEPENDENT CONTRACTOR
The Service Provider is an independent contractor and not an employee, agent, or partner of the Client. The Service Provider shall be solely responsible for the manner and means of performing the services.

5. CONFIDENTIALITY
Both parties agree to keep confidential any proprietary or sensitive information shared during the course of this Agreement. This obligation shall survive the termination of this Agreement.

6. LIABILITY
The Service Provider's total liability under this Agreement shall not exceed the total fees paid by the Client for the services. Neither party shall be liable for indirect, incidental, or consequential damages.

7. DISPUTE RESOLUTION
Any disputes arising from this Agreement shall be resolved through good-faith negotiation. If negotiation fails, the parties agree to seek mediation before pursuing any legal action.

8. GOVERNING LAW
This Agreement shall be governed by and construed in accordance with the laws of the jurisdiction in which the Service Provider operates.

9. ENTIRE AGREEMENT
This Agreement constitutes the entire agreement between the parties and supersedes all prior negotiations, representations, or agreements relating to this subject matter.

By signing below, both parties acknowledge that they have read, understood, and agree to the terms and conditions set forth in this Agreement.`,
    questions: [
      { id: 'service_description', label: 'Description of Services', type: 'textarea', placeholder: 'Describe the services to be provided...', required: true, group: 'Service Details' },
      { id: 'payment_amount', label: 'Payment Amount', type: 'number', placeholder: 'e.g. 5000', required: true, group: 'Payment' },
      { id: 'payment_terms', label: 'Payment Terms', type: 'select', required: true, group: 'Payment', options: [
        { label: 'Due on completion', value: 'Due on completion' },
        { label: 'Net 15', value: 'Net 15 days' },
        { label: 'Net 30', value: 'Net 30 days' },
        { label: '50% upfront, 50% on completion', value: '50% upfront, 50% on completion' },
      ]},
      { id: 'contract_duration', label: 'Contract Duration', type: 'select', required: true, group: 'Terms', options: [
        { label: 'One-time', value: 'a one-time engagement' },
        { label: '3 months', value: '3 months' },
        { label: '6 months', value: '6 months' },
        { label: '1 year', value: '1 year' },
        { label: 'Ongoing', value: 'an ongoing basis until terminated' },
      ]},
      { id: 'cancellation_notice', label: 'Cancellation Notice Period', type: 'select', group: 'Terms', options: [
        { label: '7 days', value: '7 days' },
        { label: '14 days', value: '14 days' },
        { label: '30 days', value: '30 days' },
      ]},
    ],
  },
  {
    id: 'nda',
    name: 'Non-Disclosure Agreement (NDA)',
    category: 'nda',
    content: `NON-DISCLOSURE AGREEMENT

This Non-Disclosure Agreement ("Agreement") is entered into as of {{date}}, by and between:

Disclosing Party: {{business_name}}
Receiving Party: {{signer_name}}

1. PURPOSE
The Disclosing Party wishes to share certain confidential and proprietary information with the Receiving Party for the purpose of evaluating or engaging in a business relationship, and the Receiving Party agrees to protect such information as outlined herein.

2. DEFINITION OF CONFIDENTIAL INFORMATION
"Confidential Information" means any and all non-public information, whether written, oral, electronic, or visual, disclosed by the Disclosing Party to the Receiving Party, including but not limited to: business plans, financial data, customer lists, trade secrets, technical specifications, product designs, marketing strategies, and any other proprietary information.

3. OBLIGATIONS OF THE RECEIVING PARTY
The Receiving Party agrees to:
a) Hold all Confidential Information in strict confidence;
b) Not disclose Confidential Information to any third party without prior written consent;
c) Use Confidential Information solely for the purpose described above;
d) Take reasonable measures to protect the confidentiality of the information, using at least the same degree of care as it uses for its own confidential information.

4. EXCLUSIONS
Confidential Information does not include information that:
a) Is or becomes publicly available through no fault of the Receiving Party;
b) Was known to the Receiving Party prior to disclosure;
c) Is independently developed by the Receiving Party without use of Confidential Information;
d) Is disclosed with the prior written approval of the Disclosing Party.

5. TERM
This Agreement shall remain in effect for a period of two (2) years from the date of execution. The obligations of confidentiality shall survive the termination of this Agreement.

6. RETURN OF INFORMATION
Upon request or termination of this Agreement, the Receiving Party shall promptly return or destroy all Confidential Information and any copies thereof.

7. REMEDIES
The Receiving Party acknowledges that any breach of this Agreement may cause irreparable harm to the Disclosing Party, and the Disclosing Party shall be entitled to seek equitable relief, including injunction, in addition to any other remedies available at law.

8. GOVERNING LAW
This Agreement shall be governed by and construed in accordance with the laws of the jurisdiction in which the Disclosing Party operates.

By signing below, the Receiving Party acknowledges receipt of this Agreement and agrees to be bound by its terms.`,
    questions: [
      { id: 'disclosure_purpose', label: 'Purpose of Disclosure', type: 'textarea', placeholder: 'e.g. Business partnership discussions', required: true, group: 'NDA Details' },
      { id: 'confidentiality_duration', label: 'Duration of Confidentiality', type: 'select', required: true, group: 'NDA Details', options: [
        { label: '1 year', value: '1 year' },
        { label: '2 years', value: '2 years' },
        { label: '5 years', value: '5 years' },
        { label: 'Indefinite', value: 'indefinitely' },
      ]},
      { id: 'is_mutual', label: 'Mutual NDA — Both parties agree to keep each other\'s information confidential', type: 'checkbox', group: 'NDA Details' },
    ],
  },
  {
    id: 'rental-agreement',
    name: 'Rental/Tenancy Agreement',
    category: 'rental',
    content: `RENTAL/TENANCY AGREEMENT

This Rental Agreement ("Agreement") is entered into as of {{date}}, by and between:

Landlord: {{business_name}}
Tenant: {{signer_name}}

1. PROPERTY
The Landlord agrees to rent to the Tenant the property located at the address specified and agreed upon by both parties (the "Property"), for residential/commercial use as agreed.

2. TERM OF LEASE
The lease shall commence on the agreed start date and continue for the agreed duration, unless terminated earlier in accordance with the terms of this Agreement.

3. RENT
The Tenant agrees to pay rent in the amount and on the schedule agreed upon by both parties. Rent shall be paid via the agreed-upon method. Late payments may be subject to penalties as specified by the Landlord.

4. SECURITY DEPOSIT
The Tenant shall pay a security deposit as agreed. The deposit shall be returned within 30 days of lease termination, less any deductions for damages, unpaid rent, or cleaning fees.

5. USE OF PROPERTY
The Tenant shall use the Property solely for the agreed purpose and shall not engage in any illegal activities on the premises. The Tenant shall not sublease or assign the Property without the Landlord's prior written consent.

6. MAINTENANCE AND REPAIRS
The Tenant shall maintain the Property in a clean and habitable condition. The Tenant shall promptly notify the Landlord of any needed repairs. The Landlord shall be responsible for structural repairs and major maintenance. The Tenant shall be responsible for minor repairs resulting from their own use.

7. UTILITIES
Unless otherwise agreed in writing, the Tenant shall be responsible for all utility charges associated with the Property.

8. ENTRY BY LANDLORD
The Landlord may enter the Property for inspections, repairs, or showings with at least 24 hours advance notice, except in cases of emergency.

9. TERMINATION
Either party may terminate this Agreement with the notice period as agreed upon or required by applicable law. Upon termination, the Tenant shall vacate the Property and return all keys.

10. GOVERNING LAW
This Agreement shall be governed by the laws of the jurisdiction in which the Property is located.

By signing below, both parties agree to the terms and conditions set forth in this Rental Agreement.`,
    questions: [
      { id: 'property_address', label: 'Property Address', type: 'textarea', placeholder: 'Full address of the property', required: true, group: 'Property Details' },
      { id: 'monthly_rent', label: 'Monthly Rent', type: 'number', placeholder: 'e.g. 1500', required: true, group: 'Financial' },
      { id: 'security_deposit', label: 'Security Deposit', type: 'number', placeholder: 'e.g. 3000', required: true, group: 'Financial' },
      { id: 'lease_start_date', label: 'Lease Start Date', type: 'date', required: true, group: 'Lease Terms' },
      { id: 'lease_duration', label: 'Lease Duration', type: 'select', required: true, group: 'Lease Terms', options: [
        { label: '6 months', value: '6 months' },
        { label: '1 year', value: '1 year' },
        { label: '2 years', value: '2 years' },
      ]},
      { id: 'utilities_included', label: 'Utilities Included', type: 'checkbox-group', group: 'Lease Terms', options: [
        { label: 'Water', value: 'Water' },
        { label: 'Electricity', value: 'Electricity' },
        { label: 'Internet', value: 'Internet' },
        { label: 'Gas', value: 'Gas' },
      ]},
    ],
  },
  {
    id: 'freelance-agreement',
    name: 'Freelance/Consulting Agreement',
    category: 'services',
    content: `FREELANCE/CONSULTING AGREEMENT

This Freelance/Consulting Agreement ("Agreement") is entered into as of {{date}}, by and between:

Client: {{business_name}}
Consultant: {{signer_name}}

1. ENGAGEMENT
The Client engages the Consultant to perform the services described and agreed upon by both parties. The Consultant accepts the engagement and agrees to perform the services in a professional and timely manner.

2. SCOPE OF WORK
The Consultant shall perform services as described in the project brief or scope of work agreed upon by both parties. Any changes to the scope must be agreed upon in writing.

3. COMPENSATION
The Client agrees to pay the Consultant at the rate or project fee agreed upon. Payment shall be made according to the agreed schedule. The Consultant shall submit invoices as required.

4. EXPENSES
The Client shall reimburse the Consultant for pre-approved, reasonable expenses incurred in the performance of services, upon presentation of receipts or documentation.

5. INDEPENDENT CONTRACTOR STATUS
The Consultant is an independent contractor, not an employee of the Client. The Consultant is responsible for their own taxes, insurance, and benefits. The Consultant may work for other clients during the term of this Agreement.

6. INTELLECTUAL PROPERTY
Unless otherwise agreed in writing, all work product, deliverables, and intellectual property created by the Consultant in the course of performing services under this Agreement shall become the property of the Client upon full payment.

7. CONFIDENTIALITY
The Consultant agrees to keep confidential all non-public information related to the Client's business, operations, and affairs. This obligation shall survive the termination of this Agreement.

8. TERM AND TERMINATION
This Agreement may be terminated by either party with 7 days written notice. In the event of termination, the Client shall pay the Consultant for all services performed and expenses incurred up to the date of termination.

9. LIMITATION OF LIABILITY
The Consultant's total liability under this Agreement shall not exceed the total compensation received. Neither party shall be liable for indirect or consequential damages.

10. GOVERNING LAW
This Agreement shall be governed by the laws of the jurisdiction in which the Client operates.

By signing below, both parties agree to the terms and conditions set forth in this Agreement.`,
    questions: [
      { id: 'scope_of_work', label: 'Scope of Work', type: 'textarea', placeholder: 'Describe the work to be performed...', required: true, group: 'Project Details' },
      { id: 'rate_type', label: 'Rate Type', type: 'radio', required: true, group: 'Compensation', options: [
        { label: 'Hourly Rate', value: 'hourly' },
        { label: 'Fixed Price', value: 'fixed' },
      ]},
      { id: 'rate_amount', label: 'Rate/Price Amount', type: 'number', placeholder: 'e.g. 75', required: true, group: 'Compensation' },
      { id: 'project_deadline', label: 'Project Deadline', type: 'date', group: 'Project Details' },
      { id: 'payment_schedule', label: 'Payment Schedule', type: 'select', required: true, group: 'Compensation', options: [
        { label: 'Weekly', value: 'Weekly' },
        { label: 'Bi-weekly', value: 'Bi-weekly' },
        { label: 'Monthly', value: 'Monthly' },
        { label: 'On completion', value: 'On completion' },
      ]},
      { id: 'ip_ownership', label: 'Intellectual Property Ownership', type: 'select', required: true, group: 'Legal', options: [
        { label: 'Belongs to client', value: 'the Client' },
        { label: 'Belongs to freelancer', value: 'the Consultant' },
        { label: 'Shared ownership', value: 'both parties jointly' },
      ]},
    ],
  },
  {
    id: 'terms-and-conditions',
    name: 'General Terms & Conditions',
    category: 'general',
    content: `TERMS AND CONDITIONS

These Terms and Conditions ("Terms") are entered into as of {{date}}, by and between:

Company: {{business_name}}
Agreed By: {{signer_name}}

1. ACCEPTANCE
By signing this document, you acknowledge that you have read, understood, and agree to be bound by these Terms and Conditions.

2. SERVICES
The Company provides the services as described and made available to the undersigned party. The Company reserves the right to modify, suspend, or discontinue any part of its services with reasonable notice.

3. PAYMENT
All fees and charges shall be as agreed between the parties. Payment is due according to the agreed schedule. Late payments may incur additional charges. All amounts are non-refundable unless otherwise stated in writing.

4. USER RESPONSIBILITIES
You agree to:
a) Provide accurate and complete information as required;
b) Comply with all applicable laws and regulations;
c) Use the services only for their intended purpose;
d) Not engage in any activity that may harm or disrupt the Company's operations.

5. INTELLECTUAL PROPERTY
All content, trademarks, and intellectual property of the Company remain the sole property of the Company. You may not reproduce, distribute, or create derivative works without prior written consent.

6. PRIVACY AND DATA
The Company will handle personal data in accordance with applicable data protection laws. Information collected will be used solely for the purposes outlined in the Company's privacy policy.

7. LIMITATION OF LIABILITY
To the maximum extent permitted by law, the Company shall not be liable for any indirect, incidental, special, or consequential damages arising from or related to these Terms or the services provided.

8. INDEMNIFICATION
You agree to indemnify and hold harmless the Company, its officers, directors, and employees from any claims, damages, or expenses arising from your breach of these Terms.

9. TERMINATION
Either party may terminate the relationship governed by these Terms with written notice. Upon termination, all outstanding obligations shall remain in effect.

10. AMENDMENTS
The Company reserves the right to update these Terms at any time. Material changes will be communicated in writing. Continued use of services after notification constitutes acceptance.

11. GOVERNING LAW
These Terms shall be governed by the laws of the jurisdiction in which the Company operates.

By signing below, you confirm your acceptance of these Terms and Conditions.`,
    questions: [
      { id: 'business_type', label: 'Type of Business', type: 'text', placeholder: 'e.g. Hair salon, Consulting firm', group: 'Business Details' },
      { id: 'refund_policy', label: 'Refund Policy', type: 'select', required: true, group: 'Policies', options: [
        { label: 'No refunds', value: 'All payments are non-refundable' },
        { label: 'Full refund within 7 days', value: 'Full refunds are available within 7 days of purchase' },
        { label: 'Full refund within 30 days', value: 'Full refunds are available within 30 days of purchase' },
        { label: 'Pro-rated refund', value: 'Pro-rated refunds are available based on services not yet rendered' },
      ]},
      { id: 'liability_cap', label: 'Liability Cap', type: 'select', required: true, group: 'Policies', options: [
        { label: 'Amount paid for service', value: 'the total amount paid for the service' },
        { label: 'Monthly fee', value: 'the monthly service fee' },
        { label: 'Custom amount', value: 'a custom amount as agreed in writing' },
      ]},
    ],
  },
];

export function fillTemplatePlaceholders(
  content: string,
  values: { business_name?: string; signer_name?: string; date?: string; [key: string]: string | undefined },
): string {
  let result = content;
  // Replace all known placeholders from the values object
  for (const [key, val] of Object.entries(values)) {
    if (val) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
    }
  }
  // Default date if not replaced
  result = result.replace(
    /\{\{date\}\}/g,
    values.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  );
  return result;
}

/**
 * Generate enriched contract content from a template + user answers.
 * Injects answer-based detail sections into the template content and replaces placeholders.
 */
export function generateContractFromAnswers(
  templateId: string,
  answers: Record<string, string>,
): string {
  const template = CONTRACT_TEMPLATES.find(t => t.id === templateId);
  if (!template) return '';

  let content = template.content;

  // Template-specific enrichments
  if (templateId === 'service-agreement') {
    // Enhance section 1 (Scope)
    if (answers.service_description) {
      content = content.replace(
        'The Service Provider agrees to provide the following services to the Client as described and agreed upon by both parties. The specific deliverables, timelines, and requirements shall be as mutually agreed in writing.',
        `The Service Provider agrees to provide the following services to the Client:\n\n${answers.service_description}\n\nAdditional deliverables, timelines, and requirements shall be as mutually agreed in writing.`,
      );
    }
    // Enhance section 2 (Compensation)
    if (answers.payment_amount || answers.payment_terms) {
      const amount = answers.payment_amount ? `$${Number(answers.payment_amount).toLocaleString()}` : 'the agreed-upon fee';
      const terms = answers.payment_terms || 'as agreed between the parties';
      content = content.replace(
        'The Client agrees to pay the Service Provider the agreed-upon fee for services rendered. Payment terms, amounts, and schedules shall be as agreed between the parties prior to commencement of services.',
        `The Client agrees to pay the Service Provider a total fee of ${amount} for services rendered. Payment terms: ${terms}.`,
      );
    }
    // Enhance section 3 (Term)
    if (answers.contract_duration || answers.cancellation_notice) {
      const duration = answers.contract_duration || 'until the services are completed';
      const notice = answers.cancellation_notice || '14 days';
      content = content.replace(
        'This Agreement shall commence on the date first written above and shall continue until the services are completed or until terminated by either party with 14 days written notice. Either party may terminate this Agreement immediately in the event of a material breach by the other party.',
        `This Agreement shall commence on the date first written above and shall continue for ${duration}, or until terminated by either party with ${notice} written notice. Either party may terminate this Agreement immediately in the event of a material breach by the other party.`,
      );
    }
    // Governing law
    if (answers.governing_jurisdiction) {
      content = content.replace(
        'This Agreement shall be governed by and construed in accordance with the laws of the jurisdiction in which the Service Provider operates.',
        `This Agreement shall be governed by and construed in accordance with the laws of the ${answers.governing_jurisdiction}.`,
      );
    }
  }

  if (templateId === 'nda') {
    // Purpose
    if (answers.disclosure_purpose) {
      content = content.replace(
        'for the purpose of evaluating or engaging in a business relationship',
        `for the purpose of ${answers.disclosure_purpose}`,
      );
    }
    // Duration
    if (answers.confidentiality_duration) {
      content = content.replace(
        'for a period of two (2) years from the date of execution',
        `for a period of ${answers.confidentiality_duration === 'indefinitely' ? 'an indefinite duration' : answers.confidentiality_duration} from the date of execution`,
      );
    }
    // Mutual
    if (answers.is_mutual === 'true') {
      content = content.replace(
        'NON-DISCLOSURE AGREEMENT',
        'MUTUAL NON-DISCLOSURE AGREEMENT',
      );
      content = content.replace(
        'Disclosing Party: {{business_name}}\nReceiving Party: {{signer_name}}',
        'Party A: {{business_name}}\nParty B: {{signer_name}}\n\nBoth parties shall be considered as both Disclosing Party and Receiving Party under this Agreement.',
      );
    }
    if (answers.governing_jurisdiction) {
      content = content.replace(
        'the laws of the jurisdiction in which the Disclosing Party operates.',
        `the laws of the ${answers.governing_jurisdiction}.`,
      );
    }
  }

  if (templateId === 'rental-agreement') {
    // Property address
    if (answers.property_address) {
      content = content.replace(
        'the property located at the address specified and agreed upon by both parties (the "Property"), for residential/commercial use as agreed.',
        `the property located at:\n${answers.property_address}\n(the "Property").`,
      );
    }
    // Lease term
    if (answers.lease_start_date || answers.lease_duration) {
      const startDate = answers.lease_start_date
        ? new Date(answers.lease_start_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : 'the agreed start date';
      const duration = answers.lease_duration || 'the agreed duration';
      content = content.replace(
        'The lease shall commence on the agreed start date and continue for the agreed duration, unless terminated earlier in accordance with the terms of this Agreement.',
        `The lease shall commence on ${startDate} and continue for a period of ${duration}, unless terminated earlier in accordance with the terms of this Agreement.`,
      );
    }
    // Rent
    if (answers.monthly_rent) {
      content = content.replace(
        'The Tenant agrees to pay rent in the amount and on the schedule agreed upon by both parties.',
        `The Tenant agrees to pay rent in the amount of $${Number(answers.monthly_rent).toLocaleString()} per month.`,
      );
    }
    // Security deposit
    if (answers.security_deposit) {
      content = content.replace(
        'The Tenant shall pay a security deposit as agreed.',
        `The Tenant shall pay a security deposit of $${Number(answers.security_deposit).toLocaleString()}.`,
      );
    }
    // Utilities
    if (answers.utilities_included) {
      const utilities = answers.utilities_included;
      if (utilities) {
        content = content.replace(
          'Unless otherwise agreed in writing, the Tenant shall be responsible for all utility charges associated with the Property.',
          `The following utilities are included in the rent: ${utilities}. The Tenant shall be responsible for all other utility charges associated with the Property.`,
        );
      }
    }
    if (answers.governing_jurisdiction) {
      content = content.replace(
        'the laws of the jurisdiction in which the Property is located.',
        `the laws of the ${answers.governing_jurisdiction}.`,
      );
    }
  }

  if (templateId === 'freelance-agreement') {
    // Scope of work
    if (answers.scope_of_work) {
      content = content.replace(
        'The Consultant shall perform services as described in the project brief or scope of work agreed upon by both parties. Any changes to the scope must be agreed upon in writing.',
        `The Consultant shall perform the following services:\n\n${answers.scope_of_work}\n\nAny changes to the scope must be agreed upon in writing.`,
      );
    }
    // Compensation
    if (answers.rate_type && answers.rate_amount) {
      const rateDesc = answers.rate_type === 'hourly'
        ? `an hourly rate of $${Number(answers.rate_amount).toLocaleString()}`
        : `a fixed project fee of $${Number(answers.rate_amount).toLocaleString()}`;
      const schedule = answers.payment_schedule ? ` Payment shall be made ${answers.payment_schedule.toLowerCase()}.` : '';
      content = content.replace(
        'The Client agrees to pay the Consultant at the rate or project fee agreed upon. Payment shall be made according to the agreed schedule. The Consultant shall submit invoices as required.',
        `The Client agrees to pay the Consultant at ${rateDesc}.${schedule} The Consultant shall submit invoices as required.`,
      );
    }
    // IP
    if (answers.ip_ownership) {
      content = content.replace(
        'all work product, deliverables, and intellectual property created by the Consultant in the course of performing services under this Agreement shall become the property of the Client upon full payment.',
        `all work product, deliverables, and intellectual property created by the Consultant in the course of performing services under this Agreement shall become the property of ${answers.ip_ownership} upon full payment.`,
      );
    }
    // Deadline
    if (answers.project_deadline) {
      const deadline = new Date(answers.project_deadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      content = content.replace(
        'The Client engages the Consultant to perform the services described and agreed upon by both parties.',
        `The Client engages the Consultant to perform the services described and agreed upon by both parties. All deliverables shall be completed by ${deadline}.`,
      );
    }
    if (answers.governing_jurisdiction) {
      content = content.replace(
        'the laws of the jurisdiction in which the Client operates.',
        `the laws of the ${answers.governing_jurisdiction}.`,
      );
    }
  }

  if (templateId === 'terms-and-conditions') {
    // Business type
    if (answers.business_type) {
      content = content.replace(
        'The Company provides the services as described and made available to the undersigned party.',
        `The Company, operating as a ${answers.business_type}, provides the services as described and made available to the undersigned party.`,
      );
    }
    // Refund policy
    if (answers.refund_policy) {
      content = content.replace(
        'All amounts are non-refundable unless otherwise stated in writing.',
        `Refund policy: ${answers.refund_policy}.`,
      );
    }
    // Liability cap
    if (answers.liability_cap) {
      content = content.replace(
        'the Company shall not be liable for any indirect, incidental, special, or consequential damages arising from or related to these Terms or the services provided.',
        `the Company\'s total liability shall not exceed ${answers.liability_cap}. The Company shall not be liable for any indirect, incidental, special, or consequential damages arising from or related to these Terms or the services provided.`,
      );
    }
    if (answers.governing_jurisdiction) {
      content = content.replace(
        'the laws of the jurisdiction in which the Company operates.',
        `the laws of the ${answers.governing_jurisdiction}.`,
      );
    }
  }

  // Replace standard placeholders
  content = fillTemplatePlaceholders(content, {
    business_name: answers.business_name,
    signer_name: answers.signer_name,
    date: answers.effective_date
      ? new Date(answers.effective_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : undefined,
  });

  return content;
}
