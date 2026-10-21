// content.js

function scrapeJobDescription() {
  const selectors = [
    '#job-description', '.job-description', '[class*="description"]', 
    '#content', 'article', 'main', 'section', '#job-details'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.innerText.length > 200) {
      return el.innerText.trim();
    }
  }
  return document.body.innerText.slice(0, 5000); 
}

function extractFormFields() {
  const fields = [];
  const elements = document.querySelectorAll("input, textarea, select");

  elements.forEach((input, index) => {
    if (input.type === "hidden" || input.type === "submit" || input.type === "file" || input.style.display === "none") {
      return;
    }

    let label = document.querySelector(`label[for="${input.id}"]`)?.innerText 
      || input.closest("label")?.innerText 
      || input.getAttribute("aria-label") 
      || input.placeholder 
      || input.name;

    if (input.type === "radio" || input.type === "checkbox") {
      const radioGroupContainer = input.closest('[role="radiogroup"]') || input.closest('.form-group');
      if (radioGroupContainer) {
        const groupLabel = radioGroupContainer.querySelector('label.control-label')?.innerText;
        if (groupLabel) {
          label = `${groupLabel} (Option: ${label})`;
        }
      }
    }

    if (label) {
      const cleanedLabel = label.replace(/\s+/g, ' ').replace(/\\\*/g, '').trim();
      const fieldData = {
        id: input.id || `field_${index}`,
        name: input.name || "",
        type: input.type || input.tagName.toLowerCase(),
        label: cleanedLabel,
        options: []
      };

      if (input.tagName.toLowerCase() === "select") {
        fieldData.options = Array.from(input.options)
          .map(opt => ({ value: opt.value, text: opt.text }))
          .filter(opt => opt.value !== "");
      }

      fields.push(fieldData);
    }
  });

  return fields;
}

function setCheckboxState(checkbox, targetState) {
  if (checkbox.checked === targetState) return;
  try {
    const nativeCheckboxValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
    nativeCheckboxValueSetter.call(checkbox, targetState);
  } catch (e) {
    checkbox.checked = targetState;
  }
  checkbox.dispatchEvent(new Event("click", { bubbles: true }));
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
}

function handlePageNavigation() {
  const nextKeywords = ["next", "continue", "proceed", "next step", "agree & continue"];
  const submitKeywords = ["submit", "finish", "submit application"];
  
  const buttons = document.querySelectorAll("button, input[type='button'], input[type='submit'], a.btn");

  let foundSubmitButton = false;
  let targetBtn = null;

  for (const btn of buttons) {
    const text = (btn.innerText || btn.value || "").toLowerCase().trim();
    if (submitKeywords.some(keyword => text === keyword || text.includes(keyword)) && btn.style.display !== "none") {
      foundSubmitButton = true;
      targetBtn = btn;
      break;
    }
  }

  if (!foundSubmitButton) {
    for (const btn of buttons) {
      const text = (btn.innerText || btn.value || "").toLowerCase().trim();
      if (nextKeywords.some(keyword => text.includes(keyword)) && btn.style.display !== "none") {
        targetBtn = btn;
        break;
      }
    }
  }

  if (targetBtn) {
    if (foundSubmitButton) {
      targetBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      targetBtn.style.outline = "6px dashed #dc2626";
      return { status: "FINAL_SUBMIT_REACHED", element: targetBtn };
    }

    targetBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    targetBtn.style.outline = "4px solid #16a34a";
    
    setTimeout(() => {
      targetBtn.click();
    }, 1000);

    return { status: "NEXT_CLICKED", element: targetBtn };
  }

  return { status: "NO_BUTTON_FOUND" };
}

// Notify sidepanel on load only if this frame has fields or is top frame
setTimeout(() => {
  const fields = extractFormFields();
  if (fields.length > 0 || window.self === window.top) {
    chrome.runtime.sendMessage({ action: "PAGE_LOADED" });
  }
}, 1500);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "EXTRACT_DATA") {
    const fields = extractFormFields();
    // Only return if this frame actually contains form fields or is the main page
    sendResponse({ 
      hasFields: fields.length > 0,
      fields: fields,
      jobDescription: scrapeJobDescription()
    });
  } else if (request.action === "AUTOFILL_FIELDS") {
    request.data.forEach(item => {
      let el = document.getElementById(item.id) || document.querySelector(`[name="${item.name}"]`);
      if (el) {
        if (el.type === "checkbox") {
          const isConsentKeyword = /agree|consent|acknowledge|privacy|talent community/i.test(el.id || el.name || "");
          const targetState = (item.answer.toLowerCase() === "true" || item.answer.toLowerCase() === "yes" || isConsentKeyword);
          setCheckboxState(el, targetState);
        } else if (el.tagName.toLowerCase() === "select") {
          el.value = item.answer;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.value = item.answer;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        const radioOption = document.getElementById(item.id);
        if (radioOption && radioOption.type === "radio") {
          if (!radioOption.checked) {
            radioOption.checked = true;
            radioOption.dispatchEvent(new Event("click", { bubbles: true }));
            radioOption.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
    });

    const checkboxes = document.querySelectorAll("input[type='checkbox']");
    checkboxes.forEach(cb => {
      const parentText = cb.closest("label")?.innerText || "";
      if (/consent|agree|privacy|talent community|acknowledge/i.test(cb.id + cb.name + parentText)) {
        setCheckboxState(cb, true);
      }
    });

    let navResult = { status: "NO_BUTTON_FOUND" };
    if (request.clickNext === true) {
      navResult = handlePageNavigation();
    }

    sendResponse({ status: "SUCCESS", navResult: navResult });
  }
});
