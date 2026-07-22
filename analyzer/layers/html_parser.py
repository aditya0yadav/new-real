# analyzer/layers/html_parser.py

import os
import copy
from bs4 import BeautifulSoup
from typing import List, Dict, Any
from analyzer.output_schema import QuestionAnswer

IGNORE_INPUT_NAMES = {'g-recaptcha-response', 'recaptcha', 'csrf', '_token', 'captcha'}

def parse_html_snapshot(html_content: str) -> List[QuestionAnswer]:
    """
    Parses an HTML snapshot and returns a list of detected questions and answers.
    Uses BeautifulSoup with the built-in html.parser.
    """
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # 1. Strip scripts, styles, metadata, and decorative elements
    for tag in soup(['script', 'style', 'noscript', 'meta', 'link', 'iframe', 'svg']):
        tag.decompose()
        
    qa_list = []
    
    # 2. Extract standard input questions (inputs, selects, radios, checkboxes)
    qa_list.extend(extract_standard_inputs(soup))
    
    # 3. Extract custom-styled components (ARIA roles or custom option classes)
    qa_list.extend(extract_custom_inputs(soup))
    
    return deduplicate_questions(qa_list)

def find_question_heading_for_input(inp: Any) -> str:
    """
    Finds the exact human-readable question title heading for an input element
    by climbing parent containers and searching for headings, legends, or fieldset titles.
    """
    inp_type = (inp.get('type') or '').lower()
    is_option_input = inp_type in ('radio', 'checkbox')

    # For text inputs, check direct associated <label for="...">
    if not is_option_input:
        inp_id = inp.get('id')
        if inp_id:
            root = inp.find_parent('form') or inp.find_parent('body') or inp.parent.parent
            if root:
                lbl = root.find('label', attrs={'for': inp_id})
                if lbl and lbl.text.strip() and len(lbl.text.strip()) > 1:
                    return lbl.text.strip()

    # Search upwards for heading elements (h1-h6, legend, p.question, etc.)
    curr = inp
    for _ in range(8):
        if not curr:
            break
            
        # Check preceding siblings for headers
        for sib in curr.previous_siblings:
            if hasattr(sib, 'name') and sib.name:
                if sib.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend']:
                    text = sib.text.strip()
                    if text and len(text) < 200 and not text.isdigit():
                        return text
                elif sib.name in ['p', 'div', 'label'] and not is_option_input:
                    text = sib.text.strip()
                    if text and 3 < len(text) < 200 and not text.isdigit():
                        return text

        # Check inside current container for heading tags
        if hasattr(curr, 'find'):
            for header_tag in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend']:
                hdr = curr.find(header_tag)
                if hdr and hdr.text.strip():
                    text = hdr.text.strip()
                    if len(text) > 2 and not text.isdigit():
                        return text

            q_el = curr.find(class_=lambda c: c and any(k in c.lower() for k in ['question', 'q-title', 'qtext', 'title', 'header']))
            if q_el and q_el.text.strip():
                return q_el.text.strip()
                
        curr = curr.parent

    name_attr = inp.get('name') or inp.get('id') or ''
    if name_attr:
        clean_name = name_attr.replace("queFld[", "").replace("]", "").replace("_", " ").title()
        return f"Form Question ({clean_name})"

    return ""

def find_label_for_input(inp: Any) -> str:
    """Finds the text label for a checkbox or radio button choice."""
    inp_id = inp.get('id')
    if inp_id:
        root = inp.find_parent('form') or inp.find_parent('body') or inp.parent.parent
        if root:
            label = root.find('label', attrs={'for': inp_id})
            if label and label.text.strip():
                return label.text.strip()
            
    parent_label = inp.find_parent('label')
    if parent_label and parent_label.text.strip():
        return parent_label.text.strip()
        
    for s in inp.next_siblings:
        text = s.text.strip() if hasattr(s, 'text') else str(s).strip()
        if text:
            return text
            
    return ""

def extract_standard_inputs(soup: BeautifulSoup) -> List[QuestionAnswer]:
    results = []
    
    # 1. Process text fields & textareas
    for inp in soup.find_all(['input', 'textarea']):
        inp_type = inp.get('type', 'text').lower()
        inp_name = (inp.get('name') or inp.get('id') or '').lower()

        if inp_type in ['radio', 'checkbox', 'hidden', 'submit', 'button', 'image', 'file']:
            continue

        if any(ign in inp_name for ign in IGNORE_INPUT_NAMES):
            continue
            
        value = inp.get('value') or (inp.string or "").strip()
        q_text = find_question_heading_for_input(inp)
        
        if q_text and not any(ign in q_text.lower() for ign in ['recaptcha', 'validation error']):
            results.append(QuestionAnswer(
                questionText=q_text,
                questionType="open_text",
                options=[],
                selectedAnswer=value if value else None,
                confidence="high" if value else "medium",
                source="html",
                elementId=inp.get('id') or inp.get('name')
            ))
            
    # 2. Process dropdown selects
    for sel in soup.find_all('select'):
        options = [opt.text.strip() for opt in sel.find_all('option') if opt.text.strip()]
        selected_opt = sel.find('option', selected=True)
        selected_val = selected_opt.text.strip() if selected_opt else None
        
        q_text = find_question_heading_for_input(sel)
        if q_text:
            results.append(QuestionAnswer(
                questionText=q_text,
                questionType="dropdown",
                options=options,
                selectedAnswer=selected_val,
                confidence="high" if selected_val else "low",
                source="html",
                elementId=sel.get('id') or sel.get('name')
            ))
            
    # 3. Process checkboxes and radio groups
    grouped_inputs: Dict[str, List[Any]] = {}
    for inp in soup.find_all('input', type=['radio', 'checkbox']):
        group_name = inp.get('name') or inp.get('id')
        if group_name:
            grouped_inputs.setdefault(group_name, []).append(inp)
            
    for name, inputs in grouped_inputs.items():
        if not inputs:
            continue
            
        options = []
        selected_answers = []
        input_type = inputs[0].get('type').lower()
        q_type = "multiple_choice" if input_type == 'radio' else "checkboxes"
        
        for inp in inputs:
            opt_text = find_label_for_input(inp)
            if opt_text:
                options.append(opt_text)
                if inp.has_attr('checked') or inp.get('checked') is not None:
                    selected_answers.append(opt_text)
                    
        q_text = find_question_heading_for_input(inputs[0])
        if q_text and options:
            ans = ", ".join(selected_answers) if q_type == "checkboxes" else (selected_answers[0] if selected_answers else None)
            results.append(QuestionAnswer(
                questionText=q_text,
                questionType=q_type,
                options=options,
                selectedAnswer=ans,
                confidence="high" if ans else "medium",
                source="html",
                elementId=name
            ))
            
    return results

def extract_custom_inputs(soup: BeautifulSoup) -> List[QuestionAnswer]:
    """Extract custom ARIA role elements (e.g. role=radio, role=checkbox)."""
    results = []
    custom_radios = soup.find_all(attrs={"role": ["radio", "option"]})
    for el in custom_radios:
        txt = el.text.strip()
        if txt:
            q_text = find_question_heading_for_input(el)
            if q_text:
                results.append(QuestionAnswer(
                    questionText=q_text,
                    questionType="multiple_choice",
                    options=[txt],
                    selectedAnswer=txt if el.get('aria-checked') == 'true' else None,
                    confidence="medium",
                    source="html",
                    elementId=el.get('id')
                ))
    return results

def deduplicate_questions(qa_list: List[QuestionAnswer]) -> List[QuestionAnswer]:
    unique = []
    seen = set()
    for q in qa_list:
        key = f"{q.questionText}:{q.elementId}"
        if key not in seen:
            seen.add(key)
            unique.append(q)
    return unique
