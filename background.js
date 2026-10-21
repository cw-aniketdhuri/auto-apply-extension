// background.js

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let activeAutomationSessions = {};

const BLOCKED_LABELS = [
  "submit application", "submit", "send application", 
  "finish application", "apply now", "apply for this job", 
  "upload resume", "attach cv", "privacy", "terms", "cookie"
];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_FULL_AUTOFILL_SESSION") {
    const tabId = request.tabId;
    activeAutomationSessions[tabId] = { isAborted: false };

    runFullAutofillSession(tabId, request.resumeText)
      .then((status) => sendResponse({ status }))
      .catch((err) => {
        console.error("[AutoApply Session Error]", err);
        sendResponse({ status: "ERROR", error: err.message });
      });

    return true; // Keep message channel open
  }

  if (request.action === "STOP_VISION_ACTIONS") {
    for (const tabId in activeAutomationSessions) {
      activeAutomationSessions[tabId].isAborted = true;
    }
    sendResponse({ status: "ACK_ABORT" });
  }
});

async function runFullAutofillSession(tabId, resumeText) {
  const target = { tabId };
  let statusResult = "SUCCESS";

  try {
    console.log(`[AutoApply] Attaching debugger to tab ${tabId}...`);
    await chrome.debugger.attach(target, "1.3");

    // ─── STEP 1: DISCOVER AND TAG ALL INTERACTIVE DOM ELEMENTS ──────────────────────
    console.log(`[AutoApply] Tagging and cataloging form fields...`);
    const domResult = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `
        (() => {
          const elements = [];
          let idCounter = 0;

          // 1. Tag Workday Dynamic "Add" buttons
          const groups = Array.from(document.querySelectorAll('[role="group"], div'));
          groups.forEach(group => {
            const heading = group.querySelector('h4, h3, [id*="-section"]');
            if (!heading) return;

            const headingText = heading.innerText.toLowerCase().trim();
            const addButton = group.querySelector('button[data-automation-id="add-button"]');
            
            if (addButton) {
              let elementId = "";
              let labelText = "";
              if (headingText.includes('experience')) {
                elementId = 'el-add-experience';
                labelText = 'Work Experience (Add Section)';
              } else if (headingText.includes('education')) {
                elementId = 'el-add-education';
                labelText = 'Education (Add Section)';
              } else if (headingText.includes('website')) {
                elementId = 'el-add-websites';
                labelText = 'Websites (Add Section)';
              }

              if (elementId) {
                addButton.setAttribute('data-autoapply-id', elementId);
                elements.push({
                  element_id: elementId,
                  tag_name: 'button',
                  input_type: 'workday_add_button',
                  label_text: labelText,
                  placeholder: 'Click to add dynamic Workday list entries',
                  x: 0, y: 0, width: 0, height: 0,
                  instance_index: 0
                });
              }
            }
          });

          // 2. Identify Cover Letter "Enter manually" Button
          const coverLetterBtn = document.querySelector(
            'button[data-testid="cover_letter-text"], [aria-labelledby*="cover_letter"] button.btn--pill, div#upload-label-cover_letter ~ * button'
          );
          if (coverLetterBtn) {
            coverLetterBtn.setAttribute('data-autoapply-id', 'el-manual-cover-letter');
            elements.push({
              element_id: 'el-manual-cover-letter',
              tag_name: 'button',
              input_type: 'cover_letter_manual_toggle',
              label_text: 'Cover Letter (Enter manually)',
              placeholder: 'Click to open cover letter textarea',
              x: 0, y: 0, width: 0, height: 0,
              instance_index: 0
            });
          }

          // 3. Mark Resume "Enter manually" Button as SKIP
          const resumeBtn = document.querySelector(
            'button[data-testid="resume-text"], [aria-labelledby*="resume"] button.btn--pill, div#upload-label-resume ~ * button'
          );
          if (resumeBtn) {
            resumeBtn.setAttribute('data-autoapply-id', 'el-manual-resume');
          }

          // 4. Catalog standard Inputs, Textareas, and Selects
          const inputs = document.querySelectorAll('input, textarea, select');
          inputs.forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (el.type === 'hidden' || el.type === 'file' || (rect.width === 0 && rect.height === 0)) {
              return;
            }

            if (el.getAttribute('data-autoapply-id')) return;

            idCounter++;
            const elementId = 'input-' + idCounter;
            el.setAttribute('data-autoapply-id', elementId);

            let labelText = "";
            if (el.id) {
              const labelNode = document.querySelector('label[for="' + el.id + '"]');
              if (labelNode) labelText = labelNode.innerText;
            }
            if (!labelText) {
              const parentLabel = el.closest('label');
              if (parentLabel) labelText = parentLabel.innerText;
            }
            if (!labelText) {
              const parentDiv = el.closest('div, section, fieldset');
              if (parentDiv) {
                const siblingLabel = parentDiv.querySelector('label, span, h3, h4');
                labelText = siblingLabel ? siblingLabel.innerText : parentDiv.innerText.split('\\n')[0];
              }
            }

            labelText = (labelText || '').replace(/\\*|\\:|Required/gi, '').trim();

            elements.push({
              element_id: elementId,
              tag_name: el.tagName.toLowerCase(),
              input_type: el.type || '',
              label_text: labelText || el.name || el.placeholder || 'Input Field',
              placeholder: el.placeholder || '',
              x: 0, y: 0, width: 0, height: 0,
              instance_index: 0
            });
          });

          return {
            pageTitle: document.title || '',
            pageUrl: window.location.href || '',
            elements: elements
          };
        })()
      `,
      returnByValue: true
    });

    let pageData = domResult.result.value || { elements: [], pageTitle: '', pageUrl: '' };
    let discoveredElements = pageData.elements;
    console.log(`[AutoApply] Cataloged ${discoveredElements.length} elements.`);

    // Keep track of how many dynamic additions we have executed per section
    let workdayAddCounters = {
      'el-add-experience': 0,
      'el-add-education': 0,
      'el-add-websites': 0
    };

    // ─── STEP 2: QUERY FASTAPI BACKEND (GEMINI 2.5) ──────────────────────────
    console.log(`[AutoApply] Sending page elements structure to Gemini...`);
    let apiResponse = await fetch("http://localhost:8000/api/vision-autofill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resume_text: resumeText,
        page_title: pageData.pageTitle,
        page_url: pageData.pageUrl,
        elements: discoveredElements
      })
    });

    if (!apiResponse.ok) {
      throw new Error(`FastAPI returned status: ${apiResponse.status}`);
    }

    let { actions } = await apiResponse.json();
    console.log(`[AutoApply] Received ${actions.length} action plans.`);

    let locateMeClicked = false;

    // ─── STEP 3: SEQUENTIALLY FILL EACH DOM ELEMENT ───────────────────────
    for (let i = 0; i < actions.length; i++) {
      const step = actions[i];
      if (activeAutomationSessions[tabId]?.isAborted) {
        statusResult = "INTERRUPTED";
        break;
      }

      const labelLower = (step.label_detected || "").toLowerCase();
      if (BLOCKED_LABELS.some(blocked => labelLower.includes(blocked))) {
        continue;
      }

      // ── SPECIAL CASE: WORKDAY DYNAMIC "ADD" BUTTONS ──
      if (step.element_id.startsWith('el-add-')) {
        const btnId = step.element_id;
        // Increment count representing which slot instance we are opening
        const currentInstanceIndex = workdayAddCounters[btnId];
        workdayAddCounters[btnId]++;

        console.log(`[AutoApply] Clicking "${step.label_detected}" (Adding slot index: ${currentInstanceIndex})...`);
        
        const addClickJS = `
          (() => {
            const btn = document.querySelector('[data-autoapply-id="${btnId}"]');
            if (btn) {
              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              btn.click();
              return true;
            }
            return false;
          })()
        `;
        await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: addClickJS });
        await sleep(800); // Wait for form to open

        // Scrape new elements, assigning them the unique instance index
        console.log(`[AutoApply] Re-scanning Workday sub-form elements with index: ${currentInstanceIndex}...`);
        const reScanResult = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression: `
            (() => {
              const subElements = [];
              const inputs = document.querySelectorAll('input:not([data-autoapply-id]), textarea:not([data-autoapply-id]), select:not([data-autoapply-id])');
              let subCounter = Date.now();

              inputs.forEach((el) => {
                const rect = el.getBoundingClientRect();
                if (el.type === 'hidden' || el.type === 'file' || (rect.width === 0 && rect.height === 0)) return;

                const elementId = 'sub-input-' + subCounter++;
                el.setAttribute('data-autoapply-id', elementId);

                let labelText = "";
                if (el.id) {
                  const labelNode = document.querySelector('label[for="' + el.id + '"]');
                  if (labelNode) labelText = labelNode.innerText;
                }
                if (!labelText) {
                  const parentLabel = el.closest('label');
                  if (parentLabel) labelText = parentLabel.innerText;
                }
                if (!labelText) {
                  const parentDiv = el.closest('div, section, fieldset');
                  if (parentDiv) {
                    const siblingLabel = parentDiv.querySelector('label, span, h3, h4');
                    labelText = siblingLabel ? siblingLabel.innerText : parentDiv.innerText.split('\\n')[0];
                  }
                }

                labelText = (labelText || '').replace(/\\*|\\:|Required/gi, '').trim();

                subElements.push({
                  element_id: elementId,
                  tag_name: el.tagName.toLowerCase(),
                  input_type: el.type || '',
                  label_text: labelText || el.name || 'Input Field',
                  placeholder: '',
                  x: 0, y: 0, width: 0, height: 0,
                  instance_index: ${currentInstanceIndex} // EXPLICIT HOOK SENT TO GEMINI
                });
              });
              return subElements;
            })()
          `,
          returnByValue: true
        });

        const newElements = reScanResult.result.value || [];
        if (newElements.length > 0) {
          console.log(`[AutoApply] Sub-scanning mapped ${newElements.length} fields. Querying Gemini...`);
          const subApiResponse = await fetch("http://localhost:8000/api/vision-autofill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resume_text: resumeText,
              page_title: pageData.pageTitle,
              page_url: pageData.pageUrl,
              elements: newElements
            })
          });

          if (subApiResponse.ok) {
            const subResult = await subApiResponse.json();
            // Splice sub-actions directly into our processing queue [source: 2, 8]
            actions.splice(i + 1, 0, ...subResult.actions);
            console.log(`[AutoApply] Spliced ${subResult.actions.length} index-matched fields into active loop [source: 2, 8].`);
          }
        }
        continue;
      }

      // ── SPECIAL CASE: COVER LETTER DYNAMIC INJECTION ──
      if (step.element_id === 'el-manual-cover-letter' || labelLower.includes("cover letter (enter manually)")) {
        console.log(`[AutoApply] Triggering "Enter manually" cover letter workflow...`);
        const coverLetterText = JSON.stringify(step.text || "");

        const clickAndInjectCoverLetterJS = `
          (() => {
            return new Promise((resolve) => {
              const btn = document.querySelector('button[data-testid="cover_letter-text"]') ||
                          document.querySelector('[data-autoapply-id="el-manual-cover-letter"]') ||
                          document.querySelector('[aria-labelledby*="cover_letter"] button.btn--pill');
                          
              if (!btn) {
                resolve({ success: false, reason: 'Cover letter button not found' });
                return;
              }

              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              btn.click();

              let attempts = 0;
              const maxAttempts = 10;

              const interval = setInterval(() => {
                attempts++;
                
                const container = btn.closest('.file-upload, [aria-labelledby*="cover_letter"], [id*="cover_letter"]') || document;
                const textarea = container.querySelector('textarea#cover_letter_text, textarea[name*="cover_letter"], textarea');

                if (textarea) {
                  clearInterval(interval);
                  textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  textarea.focus();

                  const prototype = textarea.tagName.toLowerCase() === 'textarea' 
                    ? window.HTMLTextAreaElement.prototype 
                    : window.HTMLInputElement.prototype;

                  const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                  if (nativeSetter) {
                    nativeSetter.call(textarea, ${coverLetterText});
                  } else {
                    textarea.value = ${coverLetterText};
                  }

                  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${coverLetterText} }));
                  textarea.dispatchEvent(new Event('change', { bubbles: true }));
                  textarea.dispatchEvent(new Event('blur', { bubbles: true }));

                  resolve({ success: true, method: 'Cover letter injected' });
                } else if (attempts >= maxAttempts) {
                  clearInterval(interval);
                  resolve({ success: false, reason: 'Polling timed out' });
                }
              }, 500);
            });
          })()
        `;

        const { result: coverLetterResult } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression: clickAndInjectCoverLetterJS,
          awaitPromise: true
        });

        console.log(`[AutoApply] Cover letter operation results:`, coverLetterResult.value);
        await sleep(200);
        continue;
      }

      // ── UNIVERSAL AUTOCOMPLETE DROPDOWN SELECTION ENGINE ── [source: 1, 9]
      const isComboboxField = 
        labelLower.includes("city") || 
        labelLower.includes("location") || 
        labelLower.includes("school") || 
        labelLower.includes("college") || 
        labelLower.includes("university") || 
        labelLower.includes("degree") || 
        labelLower.includes("discipline") || 
        labelLower.includes("major") ||
        labelLower.includes("start date") ||
        labelLower.includes("end date") ||
        labelLower.includes("sponsorship") ||
        labelLower.includes("visa") ||
        labelLower.includes("authorized") ||
        labelLower.includes("located in") ||
        labelLower.includes("citizen") ||
        labelLower.includes("country");

      const textValue = JSON.stringify(step.text || "");

      if (isComboboxField) {
        console.log(`[AutoApply] Handling Autocomplete Combobox field: "${step.label_detected}"...`);

        const handleAutocompleteDropdownJS = `
          (() => {
            return new Promise((resolve) => {
              const el = document.querySelector('[data-autoapply-id="${step.element_id}"]');
              if (!el) {
                resolve({ success: false, reason: 'Dropdown input element not found' });
                return;
              }

              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.focus();

              const prototype = el.tagName.toLowerCase() === 'textarea' 
                ? window.HTMLTextAreaElement.prototype 
                : window.HTMLInputElement.prototype;

              const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
              if (nativeSetter) {
                nativeSetter.call(el, ${textValue});
              } else {
                el.value = ${textValue};
              }

              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${textValue} }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
              el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));

              let attempts = 0;
              const maxAttempts = 10;

              const interval = setInterval(() => {
                attempts++;
                console.log("[AutoApply] Polling dropdown options for label \\"${step.label_detected}\\" (Attempt " + attempts + ")...");

                const selectors = [
                  '.location-autocomplete__suggestions-list > li',
                  '.pac-container .pac-item',
                  '.autocomplete-suggestions > div',
                  '.choices__list--dropdown .choices__item',
                  '[role="listbox"] [role="option"]',
                  '.select2-results__option',
                  'ul[id*="location"] li',
                  'ul[id*="school"] li',
                  'ul[id*="degree"] li',
                  'ul[id*="discipline"] li',
                  'ul[id*="major"] li',
                  'ul[id*="sponsorship"] li',
                  'ul[id*="visa"] li',
                  '.autocomplete-suggestion',
                  '.suggestions-container div',
                  '.dropdown-menu li',
                  '.dropdown-item',
                  '[class*="select-options"] div',
                  '.select-option'
                ];

                let option = null;
                const searchVal = ${textValue}.toLowerCase().trim();

                for (let sel of selectors) {
                  const items = Array.from(document.querySelectorAll(sel));
                  option = items.find(it => {
                    const rect = it.getBoundingClientRect();
                    const optText = (it.innerText || '').toLowerCase();
                    return rect.width > 0 && rect.height > 0 && (optText.includes(searchVal) || searchVal.includes(optText));
                  });

                  if (!option) {
                    option = items.find(it => {
                      const rect = it.getBoundingClientRect();
                      return rect.width > 0 && rect.height > 0;
                    });
                  }

                  if (option) break;
                }

                if (option) {
                  clearInterval(interval);
                  option.click();
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new Event('blur', { bubbles: true }));
                  resolve({ success: true, method: 'Option clicked successfully', text: option.innerText });
                } else if (attempts >= maxAttempts) {
                  clearInterval(interval);
                  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, keyCode: 40, key: 'ArrowDown' }));
                  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, keyCode: 13, key: 'Enter' }));
                  el.dispatchEvent(new Event('blur', { bubbles: true }));
                  resolve({ success: true, method: 'Keyboard navigation fallback' });
                }
              }, 250);
            });
          })()
        `;

        const { result: autocompleteResult } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression: handleAutocompleteDropdownJS,
          awaitPromise: true
        });

        console.log(`[AutoApply] Autocomplete selection result:`, autocompleteResult.value);
        await sleep(200);
        continue;
      }

      // ── STANDARD FORM FIELDS: DIRECT DOM SELECTION & REACT VALUE SETTER ── [source: 1]
      const fillJS = `
        (() => {
          const el = document.querySelector('[data-autoapply-id="${step.element_id}"]');
          if (!el) return { success: false, reason: 'Element not found by ID' };

          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus();

          // 1. Handle Checkbox / Radio
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (!el.checked) {
              el.click();
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return { success: true, type: 'click' };
          }

          // 2. Handle standard <select> dropdowns
          if (el.tagName.toLowerCase() === 'select') {
            const val = ${textValue}.toLowerCase();
            for (let opt of el.options) {
              if (opt.text.toLowerCase().includes(val) || opt.value.toLowerCase().includes(val)) {
                el.value = opt.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                break;
              }
            }
            return { success: true, type: 'select' };
          }

          // 3. Handle Text Inputs / Textareas
          const prototype = el.tagName.toLowerCase() === 'textarea' 
            ? window.HTMLTextAreaElement.prototype 
            : window.HTMLInputElement.prototype;

          const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(el, ${textValue});
          } else {
            el.value = ${textValue};
          }

          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${textValue} }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));

          return { success: true, value: el.value };
        })()
      `;

      const { result: fillResult } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: fillJS,
        returnByValue: true
      });

      console.log(`[AutoApply] Fill result for "${step.label_detected}":`, fillResult.value);
      await sleep(150);
    }

  } finally {
    delete activeAutomationSessions[tabId];
    try {
      await chrome.debugger.detach(target);
      console.log(`[AutoApply] Detached debugger cleanly.`);
    } catch (e) {}
  }

  return statusResult;
}
