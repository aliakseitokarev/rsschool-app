import { TaskChecker } from '@entities/taskChecker';
import { CourseEvent } from '@entities/courseEvent';
import { Checker, CourseTask } from '@entities/courseTask';
import { StageInterview } from '@entities/stageInterview';
import { TaskInterviewResult } from '@entities/taskInterviewResult';
import { TaskResult } from '@entities/taskResult';
import { TaskSolution } from '@entities/taskSolution';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PersonDto } from '../../core/dto';
import { Repository } from 'typeorm';
import { EventType } from '../course-events/dto/course-event.dto';
import { Course } from '@entities/course';
import * as dayjs from 'dayjs';
import { TeamDistribution } from '@entities/teamDistribution';
import { TeamDistributionStudent } from '@entities/teamDistributionStudent';

export type CourseScheduleItem = Pick<CourseTask, 'id' | 'courseId'> &
  Partial<Pick<CourseTask, 'maxScore' | 'scoreWeight'>> & {
    startDate: Date;
    endDate: Date;
    name: string;
    organizer?: PersonDto;
    score?: number;
    status: CourseScheduleItemStatus;
    tag: CourseScheduleItemTag;
    descriptionUrl?: string;
    type: CourseScheduleDataSource;
  };

export enum CourseScheduleDataSource {
  CourseTask = 'courseTask',
  CourseEvent = 'courseEvent',
  CourseTeamDistribution = 'courseTeamDistribution',
}

export enum CourseScheduleItemTag {
  Lecture = 'lecture',
  Coding = 'coding',
  SelfStudy = 'self-study',
  Interview = 'interview',
  CrossCheckSubmit = 'cross-check-submit',
  CrossCheckReview = 'cross-check-review',
  Test = 'test',
  TeamDistribution = 'team-distribution',
}

export enum CourseScheduleItemStatus {
  Done = 'done',
  Available = 'available',
  Archived = 'archived',
  Future = 'future',
  Missed = 'missed',
  Review = 'review',
  Registered = 'registered',
  Unavailable = 'unavailable',
}

@Injectable()
export class CourseScheduleService {
  constructor(
    @InjectRepository(Course)
    readonly courseRepository: Repository<Course>,
    @InjectRepository(CourseTask)
    readonly courseTaskRepository: Repository<CourseTask>,
    @InjectRepository(CourseEvent)
    readonly courseEventRepository: Repository<CourseEvent>,
    @InjectRepository(TeamDistribution)
    readonly teamDistribution: Repository<TeamDistribution>,
    @InjectRepository(TaskResult)
    readonly taskResultRepository: Repository<TaskResult>,
    @InjectRepository(TaskInterviewResult)
    readonly taskInterviewResultRepository: Repository<TaskInterviewResult>,
    @InjectRepository(StageInterview)
    readonly stageInterviewRepository: Repository<StageInterview>,
    @InjectRepository(TaskSolution)
    readonly taskSolutionRepository: Repository<TaskSolution>,
    @InjectRepository(TaskChecker)
    readonly taskCheckerRepository: Repository<TaskChecker>,
    @InjectRepository(TeamDistribution)
    readonly courseTeamDistributionRepository: Repository<TeamDistribution>,
    @InjectRepository(TeamDistributionStudent)
    private teamDistributionStudentRepository: Repository<TeamDistributionStudent>,
  ) {}

  private scheduleSort(a: CourseScheduleItem, b: CourseScheduleItem) {
    const tagPriority: { [key in CourseScheduleItemTag]?: number } = {
      'self-study': 1,
      test: 2,
      coding: 3,
    };

    const timeDifference = dayjs(a.startDate).diff(dayjs(b.startDate), 'minute');
    if (timeDifference !== 0) {
      return timeDifference;
    }

    const aTagPriority = tagPriority[a.tag] || Infinity;
    const bTagPriority = tagPriority[b.tag] || Infinity;

    return aTagPriority - bTagPriority;
  }

  private async getCourseTeamDistributions(courseId: number, studentId?: number) {
    return this.courseTeamDistributionRepository.find({
      where: { courseId },
      cache: studentId ? 90 * 1000 : undefined,
    });
  }

  private async getTeamDistributionStudents(courseId: number, studentId?: number) {
    if (!studentId) {
      return [];
    }

    const teamDistributionStudents = await this.teamDistributionStudentRepository.find({
      where: { courseId, studentId },
      relations: { student: true },
    });
    return teamDistributionStudents;
  }

  private getTeamDistributionStatus(
    teamDistribution: TeamDistribution,
    teamDistributionStudents: TeamDistributionStudent[],
  ) {
    const currTimestampUTC = dayjs();
    const distributionStartDate = dayjs(teamDistribution.startDate);
    const teamDistributionStudent = teamDistributionStudents.find(el => el.teamDistributionId === teamDistribution.id);

    if (currTimestampUTC < distributionStartDate) {
      return CourseScheduleItemStatus.Future;
    }

    if (teamDistributionStudent?.distributed) {
      return CourseScheduleItemStatus.Done;
    }

    if (teamDistributionStudent?.active) {
      return CourseScheduleItemStatus.Registered;
    }

    if (
      teamDistributionStudent?.student == null ||
      teamDistributionStudent.student.isExpelled ||
      teamDistribution.minTotalScore > teamDistributionStudent.student.totalScore
    ) {
      return CourseScheduleItemStatus.Unavailable;
    }

    const distributionEndDate = dayjs(teamDistribution.endDate);
    if (currTimestampUTC <= distributionEndDate && currTimestampUTC >= distributionStartDate) {
      return CourseScheduleItemStatus.Available;
    }

    if (currTimestampUTC > distributionEndDate) {
      return CourseScheduleItemStatus.Missed;
    }

    return CourseScheduleItemStatus.Unavailable;
  }

  public async getAll(courseId: number, studentId?: number): Promise<CourseScheduleItem[]> {
    const [courseTasks, courseEvents, teamDistribution] = await Promise.all([
      this.getActiveCourseTasks(courseId, studentId),
      this.getCourseEvents(courseId, studentId),
      this.getCourseTeamDistributions(courseId, studentId),
    ]);

    const [
      taskResults,
      interviewResults,
      technicalScreeningResults,
      taskSolutions,
      taskCheckers,
      teamDistributionStudents,
    ] = await Promise.all([
      this.getTaskResults(studentId),
      this.getInterviewResults(studentId),
      this.getPrescreeningResults(studentId),
      this.getTaskSolutions(studentId),
      this.getTaskCheckers(studentId),
      this.getTeamDistributionStudents(courseId, studentId),
    ]);

    const schedule = courseTasks
      .reduce<CourseScheduleItem[]>((acc, courseTask) => {
        const { id, courseId, studentStartDate, studentEndDate, maxScore, scoreWeight, crossCheckEndDate } = courseTask;
        const { name } = courseTask.task;

        const isCrossCheckTask = courseTask.checker === Checker.CrossCheck;

        const currentScore = this.getCurrentTaskScore(id, taskResults, interviewResults, technicalScreeningResults);
        const submitted = this.getCourseTaskSubmitted(courseTask.id, taskSolutions, taskCheckers);
        const status = this.getCourseTaskStatus(
          { startTime: courseTask.studentStartDate, endTime: courseTask.studentEndDate },
          { maxScore: courseTask.maxScore, checker: courseTask.checker },
          studentId ? { currentScore, submitted } : undefined,
        );
        const tag = this.getCourseTaskTag(courseTask);

        if (isCrossCheckTask) {
          const scheduleItems = this.transformCrossCheckTask(courseTask, submitted, currentScore, studentId);
          acc.push(...scheduleItems);
        } else {
          const scheduleItem = {
            id,
            name,
            courseId,
            startDate: studentStartDate,
            endDate: studentEndDate,
            crossCheckEndDate,
            maxScore,
            scoreWeight,
            score: currentScore,
            status,
            tag,
            descriptionUrl: courseTask.task.descriptionUrl,
            organizer: courseTask.taskOwner ? new PersonDto(courseTask.taskOwner) : null,
            type: CourseScheduleDataSource.CourseTask,
          } as CourseScheduleItem;

          acc.push(scheduleItem);
        }

        return acc;
      }, [])
      .concat(
        courseEvents.map(courseEvent => {
          const { courseId, dateTime, endTime, id } = courseEvent;
          const { name } = courseEvent.event;
          const tag = this.getCourseEventTag(courseEvent);
          return {
            id,
            name,
            courseId,
            startDate: dateTime,
            endDate: endTime,
            status: this.getEventStatus(courseEvent),
            tag,
            descriptionUrl: courseEvent.event.descriptionUrl,
            organizer: new PersonDto(courseEvent.organizer),
            type: CourseScheduleDataSource.CourseEvent,
          } as CourseScheduleItem;
        }),
      )
      .concat(
        teamDistribution.map(teamDistribution => {
          return {
            id: teamDistribution.id,
            name: teamDistribution.name,
            courseId,
            startDate: teamDistribution.startDate,
            endDate: teamDistribution.endDate,
            status: this.getTeamDistributionStatus(teamDistribution, teamDistributionStudents),
            type: CourseScheduleDataSource.CourseTeamDistribution,
            tag: CourseScheduleItemTag.TeamDistribution,
            descriptionUrl: teamDistribution.descriptionUrl,
          };
        }),
      )
      .sort(this.scheduleSort);

    return schedule;
  }

  public getCourseTaskSubmitted(courseTaskId: number, taskSolutions: TaskSolution[], taskCheckers: TaskChecker[]) {
    return (
      taskSolutions.some(solution => solution.courseTaskId === courseTaskId) ||
      taskCheckers.some(checker => checker.courseTaskId === courseTaskId)
    );
  }

  public transformCrossCheckTask(
    crossCheckTask: CourseTask,
    submitted: boolean,
    currentScore: number | null,
    studentId?: number,
  ): CourseScheduleItem[] {
    const submitRange = { startTime: crossCheckTask.studentStartDate, endTime: crossCheckTask.studentEndDate };
    const reviewRange = { startTime: crossCheckTask.studentEndDate, endTime: crossCheckTask.crossCheckEndDate };

    const submitItem = {
      id: crossCheckTask.id,
      name: crossCheckTask.task.name,
      courseId: crossCheckTask.courseId,
      startDate: crossCheckTask.studentStartDate,
      endDate: crossCheckTask.studentEndDate,
      status: this.getCrossCheckItemStatus(
        submitRange,
        CourseScheduleItemTag.CrossCheckSubmit,
        studentId ? { currentScore, submitted } : undefined,
      ),
      tag: CourseScheduleItemTag.CrossCheckSubmit,
      descriptionUrl: crossCheckTask.task.descriptionUrl,
      organizer: crossCheckTask.taskOwner ? new PersonDto(crossCheckTask.taskOwner) : null,
      scoreWeight: crossCheckTask.scoreWeight,
      score: currentScore,
      maxScore: crossCheckTask.maxScore,
      type: CourseScheduleDataSource.CourseTask,
    };

    const reviewItem = {
      id: crossCheckTask.id,
      name: crossCheckTask.task.name,
      courseId: crossCheckTask.courseId,
      startDate: crossCheckTask.studentEndDate,
      endDate: crossCheckTask.crossCheckEndDate,
      status: this.getCrossCheckItemStatus(
        reviewRange,
        CourseScheduleItemTag.CrossCheckReview,
        studentId ? { currentScore, submitted } : undefined,
      ),
      tag: CourseScheduleItemTag.CrossCheckReview,
      descriptionUrl: crossCheckTask.task.descriptionUrl,
      organizer: crossCheckTask.taskOwner ? new PersonDto(crossCheckTask.taskOwner) : null,
      scoreWeight: crossCheckTask.scoreWeight,
      score: currentScore,
      maxScore: crossCheckTask.maxScore,
    };

    return [submitItem, reviewItem] as CourseScheduleItem[];
  }

  public getCrossCheckItemStatus(
    range: { startTime: string | Date | null; endTime: string | Date | null },
    tag: CourseScheduleItemTag,
    studentData?: { currentScore: number | null; submitted: boolean },
  ) {
    if (!range.startTime || !range.endTime) {
      return CourseScheduleItemStatus.Archived;
    }

    const startTime = new Date(range.startTime).getTime();
    const endTime = new Date(range.endTime).getTime();
    const { currentScore = null, submitted = false } = studentData ?? {};
    const now = Date.now();

    if (startTime > now) {
      return CourseScheduleItemStatus.Future;
    }

    if (currentScore != null || (endTime < now && tag === CourseScheduleItemTag.CrossCheckSubmit && submitted)) {
      return CourseScheduleItemStatus.Done;
    }

    if (startTime <= now && endTime >= now) {
      return CourseScheduleItemStatus.Available;
    }

    return studentData ? CourseScheduleItemStatus.Missed : CourseScheduleItemStatus.Archived;
  }

  public async copyFromTo(fromCourseId: number, toCourseId: number) {
    const [fromCourse, toCourse] = await Promise.all([
      this.courseRepository.findOneByOrFail({ id: fromCourseId }),
      this.courseRepository.findOneByOrFail({ id: toCourseId }),
    ]);

    const [courseTasks, courseEvents, courseTeamDistributions] = await Promise.all([
      this.courseTaskRepository.find({ where: { courseId: fromCourseId } }),
      this.courseEventRepository.find({ where: { courseId: fromCourseId } }),
      this.teamDistribution.find({ where: { courseId: fromCourseId } }),
    ]);

    const timeDiff = toCourse.startDate.getTime() - fromCourse.startDate.getTime();

    for (const courseTask of courseTasks) {
      const { id, createdDate, updatedDate, crossCheckStatus, ...newCourseTask } = courseTask;
      newCourseTask.courseId = toCourseId;
      newCourseTask.crossCheckEndDate = this.adjustDate(newCourseTask.crossCheckEndDate, timeDiff);
      newCourseTask.studentStartDate = this.adjustDate(newCourseTask.studentStartDate, timeDiff);
      newCourseTask.studentEndDate = this.adjustDate(newCourseTask.studentEndDate, timeDiff);
      newCourseTask.mentorStartDate = this.adjustDate(newCourseTask.mentorStartDate, timeDiff);
      newCourseTask.mentorEndDate = this.adjustDate(newCourseTask.mentorEndDate, timeDiff);
      newCourseTask.studentRegistrationStartDate = this.adjustDate(
        newCourseTask.studentRegistrationStartDate,
        timeDiff,
      );
      await this.courseTaskRepository.save(newCourseTask);
    }

    for (const courseEvent of courseEvents) {
      const { id, createdDate, updatedDate, ...newCourseEvent } = courseEvent;
      newCourseEvent.courseId = toCourseId;
      newCourseEvent.dateTime = this.adjustDate(newCourseEvent.dateTime, timeDiff);
      newCourseEvent.endTime = this.adjustDate(newCourseEvent.endTime, timeDiff);
      newCourseEvent.date = null;
      newCourseEvent.time = null;
      await this.courseEventRepository.save(newCourseEvent);
    }

    for (const teamDistribution of courseTeamDistributions) {
      const { id, createdDate, updatedDate, ...newTeamDistribution } = teamDistribution;
      newTeamDistribution.courseId = toCourseId;
      newTeamDistribution.startDate =
        this.adjustDate(newTeamDistribution.startDate, timeDiff) ?? newTeamDistribution.startDate;
      newTeamDistribution.endDate =
        this.adjustDate(newTeamDistribution.endDate, timeDiff) ?? newTeamDistribution.endDate;
      await this.teamDistribution.save(newTeamDistribution);
    }
  }

  private adjustDate(date: string | Date | null, timeDiff: number): Date | null {
    const fixedDate = typeof date === 'string' ? new Date(date) : date;
    return fixedDate ? new Date((fixedDate as Date).getTime() + timeDiff) : fixedDate;
  }

  private getCurrentTaskScore(
    courseTaskId: number,
    taskResults: TaskResult[],
    interviewResults: TaskInterviewResult[],
    technicalScreeningResults: StageInterview[],
  ) {
    const scoreRaw =
      taskResults.find(task => task.courseTaskId === courseTaskId)?.score ??
      interviewResults.find(task => task.courseTaskId === courseTaskId)?.score ??
      Math.max(
        ...(technicalScreeningResults
          .find(task => task.courseTaskId === courseTaskId)
          ?.stageInterviewFeedbacks.map(feedback => JSON.parse(feedback.json))
          .map((json: any) => {
            const resumeScore = json?.resume?.score;
            const decisionScore = json?.steps?.decision?.values?.finalScore;
            return resumeScore ?? decisionScore ?? 0;
          }) ?? []),
      );
    const currentScore = isFinite(scoreRaw) ? scoreRaw : null;
    return currentScore;
  }

  private async getTaskSolutions(studentId: number | undefined): Promise<TaskSolution[]> {
    if (!studentId) {
      return [];
    }
    return this.taskSolutionRepository.find({
      where: { studentId },
      select: ['id', 'url', 'courseTaskId', 'studentId'],
    });
  }

  private async getPrescreeningResults(studentId: number | undefined): Promise<StageInterview[]> {
    if (!studentId) {
      return [];
    }
    return this.stageInterviewRepository.find({
      where: { studentId, isCompleted: true },
      relations: ['stageInterviewFeedbacks'],
    });
  }

  private async getInterviewResults(studentId: number | undefined): Promise<TaskInterviewResult[]> {
    if (!studentId) {
      return [];
    }
    return this.taskInterviewResultRepository.find({
      where: { studentId },
      select: ['id', 'score', 'studentId', 'courseTaskId'],
    });
  }

  private async getTaskResults(studentId: number | undefined): Promise<TaskResult[]> {
    if (!studentId) {
      return [];
    }
    return this.taskResultRepository.find({
      where: { studentId },
      select: ['id', 'score', 'studentId', 'courseTaskId'],
    });
  }

  private async getTaskCheckers(studentId: number | undefined): Promise<TaskChecker[]> {
    if (!studentId) {
      return [];
    }
    return this.taskCheckerRepository.find({
      where: { studentId },
      select: ['id', 'studentId', 'courseTaskId'],
    });
  }

  private async getActiveCourseTasks(courseId: number, studentId?: number): Promise<CourseTask[]> {
    return this.courseTaskRepository.find({
      where: { courseId, disabled: false },
      relations: ['task', 'taskOwner'],
      cache: studentId ? 90 * 1000 : undefined,
    });
  }

  private async getCourseEvents(courseId: number, studentId?: number): Promise<CourseEvent[]> {
    return this.courseEventRepository.find({
      where: { courseId },
      relations: ['event', 'organizer'],
      cache: studentId ? 90 * 1000 : undefined,
    });
  }

  private getEventStatus(courseEvent: CourseEvent) {
    const startTime = (courseEvent.dateTime as Date).getTime();
    const endTime = Number(courseEvent.endTime) || startTime + (courseEvent.duration ?? 60) * 1000 * 60;
    if (endTime && endTime < Date.now()) {
      return CourseScheduleItemStatus.Archived;
    }
    if (startTime < Date.now()) {
      return CourseScheduleItemStatus.Available;
    }
    return CourseScheduleItemStatus.Future;
  }

  private getCourseTaskStatus(
    range: { startTime: string | Date | null; endTime: string | Date | null },
    task: Pick<CourseTask, 'maxScore' | 'checker'>,
    studentData?: { currentScore: number | null; submitted: boolean },
  ) {
    if (!range.startTime || !range.endTime) {
      return CourseScheduleItemStatus.Archived;
    }
    const startTime = new Date(range.startTime).getTime();
    const endTime = new Date(range.endTime).getTime();
    const { currentScore = null, submitted = false } = studentData ?? {};
    const now = Date.now();
    const isAvailablePeriod = startTime <= now && endTime >= now;
    const isAvailableAutoTest = isAvailablePeriod && task.checker === Checker.AutoTest;
    if (startTime > now) {
      return CourseScheduleItemStatus.Future;
    }
    if (isAvailableAutoTest && Number(currentScore) < task.maxScore) {
      return CourseScheduleItemStatus.Available;
    }
    if (currentScore != null) {
      return CourseScheduleItemStatus.Done;
    }
    if (submitted) {
      return CourseScheduleItemStatus.Review;
    }
    if (isAvailablePeriod) {
      return CourseScheduleItemStatus.Available;
    }
    return studentData ? CourseScheduleItemStatus.Missed : CourseScheduleItemStatus.Archived;
  }

  private getCourseTaskTag(courseTask: CourseTask): CourseScheduleItemTag {
    const taskType = courseTask.type || courseTask.task.type;

    if (taskType === 'selfeducation' || taskType === 'test') {
      return CourseScheduleItemTag.Test;
    }
    if (taskType === 'interview' || taskType === 'stage-interview') {
      return CourseScheduleItemTag.Interview;
    }
    return CourseScheduleItemTag.Coding;
  }

  private getCourseEventTag(courseEvent: CourseEvent): CourseScheduleItemTag {
    const type = courseEvent.event.type as EventType;
    switch (type) {
      case EventType.SelfStudy:
        return CourseScheduleItemTag.SelfStudy;
      default:
        return CourseScheduleItemTag.Lecture;
    }
  }
}
