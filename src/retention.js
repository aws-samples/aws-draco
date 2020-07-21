// Returns the ISO week of the date.
Date.prototype.getUTCWeek = function() {
  var date = new Date(this.getTime());
  date.setUTCHours(0, 0, 0, 0);
  // Thursday in current week decides the year.
  date.setUTCDate(date.getUTCDate() + 3 - (date.getUTCDay() + 6) % 7);
  // January 4 is always in week 1.
  var week1 = new Date(date.getUTCFullYear(), 0, 4);
  // Adjust to Thursday in week 1 and count number of weeks from date to week1.
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000
                        - 3 + (week1.getUTCDay() + 6) % 7) / 7);
};

// Returns the four-digit year corresponding to the ISO week of the date.
Date.prototype.getUTCWeekYear = function() {
  var date = new Date(this.getTime());
  date.setUTCDate(date.getUTCDate() + 3 - (date.getUTCDay() + 6) % 7);
  return date.getUTCFullYear();
};

/*
 * Given a list of snapshots and the lifecycle policy, update the list with the ones to be retained
 */
exports.implementPolicy = async (snapshot_list, policy) => {

  let snapshots = snapshot_list.map( s => {
      let clone = { ...s };
      let snapshot_date = new Date(s.date);
      clone.date = snapshot_date.getUTCDate(),
      clone.dow = snapshot_date.getUTCDay(), // 0=Sun
      clone.week = snapshot_date.getUTCWeek(),
      clone.month = snapshot_date.getUTCMonth(),
      clone.year = snapshot_date.getUTCFullYear()
      clone.weekyear = snapshot_date.getUTCWeekYear()
      return clone;
  }).sort((a,b) => a.age - b.age); // youngest first

  // Get the Tags on the most recent Snapshot
  switch (policy) {
    // Keep one per day for a week, weekly for a month, monthly for a year
    case 'Standard': {
      const MAX_YEARS = 7;
      let dailies = 0;
      let weeklies = 0;
      let monthlies = 0;
      let yearlies = 0;
      let date = -1;
      let week = -1;
      let month = -1;
      let year = -1;
      for (let s of snapshots) {
        s.retain = false;
        if (s.date != date && dailies < 7) {
          date = s.date;
          dailies += 1;
          s.retain = true;
        }
        if (s.week != week && weeklies < 5) {
          week = s.week;
          weeklies += 1;
          s.retain = true;
        }
        if (s.month != month && monthlies < 12) {
          month = s.month;
          monthlies += 1;
          s.retain = true;
        }
        if (s.year != year && yearlies < MAX_YEARS) {
          yearlies += 1;
          year = s.year;
          s.retain = true;
        }
      }
      break;
    }
    case 'Weekly': { // Keep the last seven days
      let dailies = 0;
      let date = -1;
      for (let s of snapshots) {
        s.retain = false;
        if (s.date != date && dailies < 7) {
          date = s.date;
          dailies += 1;
          s.retain = true;
        }
      }
      break;
    }
    case 'Fortnightly': { // Keep the last fourteen days
      let dailies = 0;
      let date = -1;
      for (let s of snapshots) {
        s.retain = false;
        if (s.date != date && dailies < 14) {
          date = s.date;
          dailies += 1;
          s.retain = true;
        }
      }
      break;
    }
    case 'Biweekly': { // Keep just two, one for each of the last two weeks.
      let date = -1;
      let week = -1;
      let weeklies = 0;
      for (let s of snapshots) {
        s.retain = false;
        if (weeklies >= 2) continue;
        if (s.date != date && s.week != week) {
          date = s.date;
          week = s.week;
          weeklies += 1;
          s.retain = true;
        }
        if (s.week != week) {
          week = s.week;
          weeklies += 1;
          s.retain = true;
        }
      }
      break;
    }
    case 'SemiMonthly': { // Keep two weeks of dailies then two weeklies (total 16)
      let date = -1;
      let week = -1;
      let dailies = 0;
      let weeklies = 0;
      for (let s of snapshots) {
        s.retain = false;
        if (s.date != date) {
          date = s.date;
          dailies += 1;
          if (dailies <= 14) s.retain = true;
          if (s.week != week) {
            week = s.week;
            weeklies += 1;
            if (weeklies <= 4) s.retain = true;
          }
        }
      }
      break;
    }
    case 'Monthly': { // Keep a month of dailies
      let date = -1;
      let monthdatetick = (snapshots[0].year * 10000) + (snapshots[0].month-1) * 100 + snapshots[0].date;
      for (let s of snapshots) {
        s.retain = false;
        if (s.date != date && (s.year * 10000 + s.month*100 + s.date > monthdatetick)) {
          date = s.date;
          s.retain = true;
        }
      }
      break;
    }
    case 'CurrentMonth': { // Keep only the current month
      let date = -1;
      let month = snapshots[0].month;
      for (let s of snapshots) {
        s.retain = false;
        if (s.date != date && s.month == month) {
          date = s.date;
          s.retain = true;
        }
      }
      break;
    }
    case 'Test': { // Keep up to 3 most recent
      snapshots.forEach((s,ix) => s.retain = ix < 3);
      break;
    }
    default:
      console.log(`Lifecycle '${policy}' not supported`);
      break;
  }
  return snapshots;
}

// vim: sts=2 et sw=2:
