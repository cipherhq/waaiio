export interface ContractTemplate {
  id: string;
  name: string;
  category: string;
  content: string;
}

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
  },
];

export function fillTemplatePlaceholders(
  content: string,
  values: { business_name?: string; signer_name?: string; date?: string },
): string {
  let result = content;
  if (values.business_name) {
    result = result.replace(/\{\{business_name\}\}/g, values.business_name);
  }
  if (values.signer_name) {
    result = result.replace(/\{\{signer_name\}\}/g, values.signer_name);
  }
  result = result.replace(
    /\{\{date\}\}/g,
    values.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  );
  return result;
}
