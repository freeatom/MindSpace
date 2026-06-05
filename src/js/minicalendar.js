/**
 * MiniCalendar — reusable month grid for event date picking
 */
class MiniCalendar {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.today = new Date();
    this.today.setHours(0, 0, 0, 0);
    this.current = new Date(this.today.getFullYear(), this.today.getMonth(), 1);
    this.selectedDate = options.initialDate ? new Date(options.initialDate) : null;
    if (this.selectedDate) this.selectedDate.setHours(0, 0, 0, 0);

    this.onDateSelect = options.onDateSelect || (() => {});
    this.eventDates = options.eventDates || [];
    this.gridClass = options.gridClass || '';
    this.allowPast = !!options.allowPast;
    this.prevId = options.prevId || 'cal-prev';
    this.nextId = options.nextId || 'cal-next';
    this.hideNav = !!options.hideNav;
    this.render();
  }

  setEventDates(dates) {
    this.eventDates = dates;
    this.render();
  }

  setMonth(year, month) {
    this.current = new Date(year, month, 1);
    this.render();
  }

  dateKey(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toDateString();
  }

  hasEvent(date) {
    const key = this.dateKey(date);
    return this.eventDates.some((ed) => this.dateKey(new Date(ed)) === key);
  }

  render() {
    const year = this.current.getFullYear();
    const month = this.current.getMonth();
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDay = new Date(year, month, 1).getDay();

    let html = '';
    if (!this.hideNav) {
      html += `
      <div class="cal-nav">
        <button type="button" class="cal-nav-btn" id="${this.prevId}">&#8249;</button>
        <span class="cal-month-label">${monthNames[month]} ${year}</span>
        <button type="button" class="cal-nav-btn" id="${this.nextId}">&#8250;</button>
      </div>`;
    }
    html += `<div class="cal-grid ${this.gridClass}">
        <div class="cal-day-name">Su</div>
        <div class="cal-day-name">Mo</div>
        <div class="cal-day-name">Tu</div>
        <div class="cal-day-name">We</div>
        <div class="cal-day-name">Th</div>
        <div class="cal-day-name">Fr</div>
        <div class="cal-day-name">Sa</div>
    `;

    for (let i = 0; i < firstDay; i++) {
      html += '<div class="cal-cell empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      date.setHours(0, 0, 0, 0);
      const isToday = this.dateKey(date) === this.dateKey(this.today);
      const isSelected = this.selectedDate && this.dateKey(date) === this.dateKey(this.selectedDate);
      const isPast = date < this.today;
      const hasEvent = this.hasEvent(date);
      const pastClass = isPast && !this.allowPast ? 'past' : '';

      html += `
        <div class="cal-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}
                          ${pastClass} ${hasEvent ? 'has-event' : ''}"
             data-date="${date.toISOString().slice(0, 10)}">
          ${d}
        </div>`;
    }

    html += '</div>';
    this.container.innerHTML = html;
    this.bindEvents();
  }

  bindEvents() {
    if (!this.hideNav) {
      const prev = this.container.querySelector(`#${this.prevId}`);
      const next = this.container.querySelector(`#${this.nextId}`);
      if (prev) {
        prev.onclick = () => {
          this.current.setMonth(this.current.getMonth() - 1);
          this.render();
        };
      }
      if (next) {
        next.onclick = () => {
          this.current.setMonth(this.current.getMonth() + 1);
          this.render();
        };
      }
    }

    this.container.querySelectorAll('.cal-cell:not(.empty)').forEach((cell) => {
      if (cell.classList.contains('past') && !this.allowPast) return;
      cell.onclick = () => {
        this.selectedDate = new Date(cell.dataset.date + 'T00:00:00');
        this.selectedDate.setHours(0, 0, 0, 0);
        this.onDateSelect(this.selectedDate);
        this.render();
      };
    });
  }

  getSelectedDate() {
    return this.selectedDate;
  }
}

window.MiniCalendar = MiniCalendar;
