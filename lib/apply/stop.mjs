// The run's terminal error: Stop carries the stop reason and exit code to run()'s catch; invalidPlan
// refuses a model-proposed plan step, which re-drives instead of stopping.

export class Stop extends Error {
  constructor(reason, code = 0) {
    super(reason);
    this.code = code;
  }
}

export const invalidPlan = reason => { throw new Stop(`invalid-plan ${reason}`, 1); };
