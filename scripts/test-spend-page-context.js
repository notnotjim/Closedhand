const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function guard() {
  const context = { module: { exports: {} }, URL, console, require: () => ({}) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/spend-guard'), 'utf8'), context);
  return context.module.exports;
}
test('payment lookup submissions are not purchases, but explicit pay actions still are', () => {
  const g = guard();
  for (const url of ['https://example.com/payment-lookup/', 'https://example.com/payments/search']) {
    g.notePage('u', url, 'Payment Lookup Page');
    assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'batch', steps: [{ action: 'fill', selector: '#reference', text: 'example' }, { action: 'click', selector: 'button[type=submit]' }] }), null);
    assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'press', key: 'Enter' }), null);
    assert.ok(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: 'text=Pay now' }));
  }
});
test('checkout still gates generic submits, including saved-card and misleading-title pages', () => {
  const g = guard();
  for (const url of ['https://example.com/checkout', 'https://example.com/payment', 'https://example.com/checkout/payment-lookup']) {
    g.notePage('u', url, 'Payment Lookup');
    assert.ok(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: 'button[type=submit]' }));
  }
});
test('batch navigation replaces stale checkout context without exempting later payment steps', () => {
  const g = guard();
  g.notePage('u', 'https://example.com/checkout', 'Checkout');
  const steps = [{ action: 'navigate', url: 'https://example.com/payment-lookup' }, { action: 'click', selector: 'button[type=submit]' }];
  assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'batch', steps }), null);
  assert.ok(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'batch', steps: [...steps, { action: 'navigate', url: 'https://example.com/checkout' }, { action: 'click', selector: 'button[type=submit]' }] }));
});
test('a payment word in a host or return URL does not turn a lookup into checkout', () => {
  const g = guard();
  g.notePage('u', 'https://payments.example.com/search?return=/checkout', 'Search transactions');
  assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: 'button[type=submit]' }), null);
});

// An agent asked to fill an Amazon basket clicked "add-to-cart-button" by
// script on a product page, after looking at the basket, and was stopped with
// "I'm about to pay": the basket page left from before counted as a checkout.
test('adding to a basket is never paying, and a step is judged by the page it names', () => {
  const g = guard();
  g.notePage('u', 'https://shop.example/gp/cart/view.html', 'Shopping Basket');
  const add = (script, url = 'https://shop.example/dp/X1') => g.spendIntent('sandbox_browse', { _userId: 'u', action: 'eval_js', url, browser: 'visible', script });
  assert.equal(add("(()=>{const b=document.getElementById('add-to-cart-button');if(!b)return 'NO BUTTON | '+document.title;b.click();return 'clicked | '+document.title;})()"), null);
  assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: '#add-to-cart-button' }), null, 'a click that adds, even on the basket page');
  assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: 'input[name="submit.add-to-cart"]' }), null);
  assert.ok(add("document.getElementById('add-to-cart-button').click(); document.getElementById('buy-now-button').click()"), 'adding and buying in one script is still stopped');
  assert.ok(add("document.querySelector('#place-your-order').click()", 'https://shop.example/checkout/spc'), 'and so is any click on a checkout it names');
  assert.ok(add("document.querySelector('button.primary').click()", null), 'a script with no page of its own is judged by the basket it is on');
  assert.ok(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: 'text=Proceed to checkout' }), 'going to the checkout is still asked about');
});
