import { describe, it, expect } from 'vitest';
import { formatBankTransferBlock, getBankOnlyButtons, getDualOptionButtons } from '../shared/bank-transfer';

describe('bank transfer localization', () => {
  const mockAccount = {
    bank_name: 'First Bank',
    account_number: '0123456789',
    account_name: 'Bukka Hut Ltd',
  };

  it('en session renders transfer block with account details filled in', () => {
    const block = formatBankTransferBlock(mockAccount, '₦5,000', 'WA-A1B2', 'en');
    expect(block).toContain('Bank: First Bank');
    expect(block).toContain('Account: 0123456789');
    expect(block).toContain('Name: Bukka Hut Ltd');
    expect(block).toContain('Amount: ₦5,000');
    expect(block).toContain('*WA-A1B2*');
  });

  it('pcm session renders transfer block in Pidgin with account details filled in', () => {
    const block = formatBankTransferBlock(mockAccount, '₦5,000', 'WA-A1B2', 'pcm');
    // pcm has different ref_warning and transfer_hint
    expect(block).toContain('Bank: First Bank');
    expect(block).toContain('Account: 0123456789');
    expect(block).toContain('Name: Bukka Hut Ltd');
    expect(block).toContain('Amount: ₦5,000');
    expect(block).toContain('*WA-A1B2*');
    // Check for pidgin-specific text
    expect(block).toContain('dis reference');  // pcm ref_warning uses "dis reference"
    expect(block).toContain('dey transfer');    // pcm ref_warning contains "dey transfer"
  });

  it('getBankOnlyButtons returns localized labels', () => {
    const enBtns = getBankOnlyButtons('en');
    expect(enBtns).toHaveLength(2);
    expect(enBtns[0].id).toBe('sent_transfer');
    expect(enBtns[0].title.length).toBeLessThanOrEqual(20);
    expect(enBtns[1].id).toBe('go_back');

    const pcmBtns = getBankOnlyButtons('pcm');
    expect(pcmBtns[0].id).toBe('sent_transfer');
    // pcm has its own translation for ive_sent_transfer
    expect(pcmBtns[0].title.length).toBeLessThanOrEqual(20);
  });

  it('getDualOptionButtons returns three buttons with localized labels', () => {
    const btns = getDualOptionButtons('en');
    expect(btns).toHaveLength(3);
    expect(btns[0].id).toBe('i_paid_online');
    expect(btns[1].id).toBe('sent_transfer');
    expect(btns[2].id).toBe('go_back');
    // All within WhatsApp button limit
    for (const btn of btns) {
      expect(btn.title.length).toBeLessThanOrEqual(20);
    }

    const pcmBtns = getDualOptionButtons('pcm');
    expect(pcmBtns[0].title).toContain('Pay');  // pcm: "I Don Pay Online"
    for (const btn of pcmBtns) {
      expect(btn.title.length).toBeLessThanOrEqual(20);
    }
  });

  it('defaults to English when no lang provided', () => {
    const block = formatBankTransferBlock(mockAccount, '₦1,000', 'WA-XY12');
    expect(block).toContain('Bank: First Bank');
    expect(block).toContain('Use reference *WA-XY12*');
  });
});
