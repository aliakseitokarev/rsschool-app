import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Mentor } from '@entities/mentor';
import { Student } from '@entities/student';
import { CourseTask, Checker } from '@entities/courseTask';
import { TaskResult } from '@entities/taskResult';
import { TaskSolution } from '@entities/taskSolution';
import { Task } from '@entities/task';

import { MentorBasic, MentorDetails } from '@common/models';

import { PersonDto } from 'src/core/dto';
import { MentorDashboardDto, SolutionItemStatus } from './dto/mentor-dashboard.dto';
import * as dayjs from 'dayjs';
import { TaskChecker, User } from '../../../../server/src/models';
import { PreferredStudentsLocation } from '@common/enums/mentor';

export interface SolutionItem {
  maxScore: number;
  taskName: string;
  taskDescriptionUrl: string;
  courseTaskId: number;
  resultScore: number | null;
  solutionUrl: string;
  status: SolutionItemStatus;
  endDate: string;
  person: PersonDto;
}

@Injectable()
export class MentorsService {
  constructor(
    @InjectRepository(Mentor)
    readonly mentorsRepository: Repository<Mentor>,
    @InjectRepository(Student)
    readonly studentRepository: Repository<Student>,
    @InjectRepository(TaskSolution)
    readonly taskSolutionRepository: Repository<TaskSolution>,
    @InjectRepository(TaskChecker)
    readonly taskCheckerRepository: Repository<TaskChecker>,
  ) {}

  public static convertMentorToMentorBasic(mentor: Mentor): MentorBasic {
    const user = mentor.user;
    return {
      id: mentor.id,
      name: PersonDto.getName(user),
      githubId: user.githubId,
      cityName: user.cityName ?? '',
      countryName: user.countryName ?? '',
      isActive: !mentor.isExpelled,
      students: mentor.students?.filter(s => !s.isExpelled && !s.isFailed).map(s => ({ id: s.id })) ?? [],
    };
  }

  public static convertMentorToMentorDetails(mentor: Mentor): MentorDetails {
    const mentorBasic = MentorsService.convertMentorToMentorBasic(mentor);
    const user = mentor.user;
    return {
      ...mentorBasic,
      students: mentor.students ?? [],
      cityName: user.cityName ?? '',
      countryName: user.countryName ?? '',
      maxStudentsLimit: mentor.maxStudentsLimit,
      studentsPreference: mentor.studentsPreference ?? PreferredStudentsLocation.ANY,
      studentsCount: mentor.students ? mentor.students.length : 0,
      screenings: {
        total: mentor.stageInterviews ? mentor.stageInterviews.length : 0,
      },
    };
  }

  public getById(mentorId: number) {
    return this.mentorsRepository.findOne({
      where: { id: mentorId },
    });
  }

  public getByUserId(courseId: number, userId: number) {
    return this.mentorsRepository.findOne({
      where: { courseId, userId },
    });
  }

  public getStudents(mentorId: number, userId: number) {
    return this.studentRepository
      .createQueryBuilder('student')
      .leftJoinAndSelect('student.user', 'user')
      .leftJoinAndSelect('student.feedbacks', 'feedback', 'feedback.auhtorId = :userId', { userId })
      .where('student.mentorId = :mentorId', { mentorId })
      .getMany();
  }

  public async getCourseStudentsCount(mentorId: number, courseId: number) {
    return await this.studentRepository.count({
      where: { mentorId, courseId },
    });
  }

  private async getSolutions(mentorId: number, courseId: number): Promise<SolutionItem[]> {
    const solutions = await this.taskSolutionRepository
      .createQueryBuilder('ts')
      .leftJoin(TaskResult, 'tr', 'tr."studentId" = ts."studentId" AND tr."courseTaskId" = ts."courseTaskId"')
      .leftJoin(TaskChecker, 'tc', 'tc."studentId" = ts."studentId" AND tc."courseTaskId" = ts."courseTaskId"')
      .innerJoin(CourseTask, 'ct', 'ct.id = ts."courseTaskId"')
      .innerJoin(Task, 't', 't.id = ct."taskId"')
      .innerJoin(Student, 's', 's.id = ts."studentId"')
      .innerJoin(User, 'u', 'u.id = s."userId"')
      .select([
        's.id',
        's.mentorId',
        'u.firstName',
        'u.lastName',
        'u.githubId',
        't.name',
        't.descriptionUrl',
        'ct.id',
        'ct.maxScore',
        'ct.studentEndDate',
        'ts.studentId',
        'tr.score',
        'ts.url',
      ])
      .where('s."courseId" = :courseId', { courseId })
      .andWhere('ct.checker = :checker', { checker: Checker.Mentor })
      .andWhere('s."mentorId" = :mentorId', { mentorId })
      .orWhere('tc."mentorId" = :mentorId', { mentorId })
      .orderBy('ct."studentEndDate"', 'DESC')
      .getRawMany();

    return solutions.map(s => ({
      taskName: s.t_name,
      courseTaskId: s.ct_id,
      maxScore: s.ct_maxScore,
      resultScore: s.tr_score,
      solutionUrl: s.ts_url,
      taskDescriptionUrl: s.t_descriptionUrl,
      status: this.getStatus(s.s_mentorId, s.tr_score),
      endDate: dayjs(s.ct_studentEndDate).add(2, 'w').toISOString(),
      person: new PersonDto({
        id: s.s_id,
        firstName: s.u_firstName,
        lastName: s.u_lastName,
        githubId: s.u_githubId,
      }),
    }));
  }

  private getStatus(mentorId: number, resultScore: number) {
    // resultScore = 0 should be considered as a result
    const hasScore = resultScore !== null;
    if (!mentorId && !hasScore) {
      return SolutionItemStatus.RandomTask;
    }

    return hasScore ? SolutionItemStatus.Done : SolutionItemStatus.InReview;
  }

  public async getStudentsTasks(mentorId: number, courseId: number): Promise<MentorDashboardDto[]> {
    const solutions = await this.getSolutions(mentorId, courseId);
    return solutions.map(solution => new MentorDashboardDto(solution));
  }

  private async getRandomSolution(courseId: number): Promise<{ courseTaskId: number; studentId: number }> {
    const task = await this.taskSolutionRepository
      .createQueryBuilder('ts')
      .leftJoin(TaskResult, 'tr', 'tr."studentId" = ts."studentId" AND tr."courseTaskId" = ts."courseTaskId"')
      .leftJoin(TaskChecker, 'tc', 'tc."studentId" = ts."studentId" AND tc."courseTaskId" = ts."courseTaskId"')
      .innerJoin(CourseTask, 'ct', 'ct.id = ts."courseTaskId"')
      .innerJoin(Student, 's', 's.id = ts."studentId"')
      .select(['ts.studentId', 'ts.courseTaskId', 'tc.id'])
      .where('s."courseId" = :courseId', { courseId })
      .andWhere('s."isExpelled" = false')
      .andWhere('s."mentorId" IS NULL')
      .andWhere('ct.checker = :checker', { checker: Checker.Mentor })
      .andWhere('tr."score" IS NULL')
      .andWhere('tc."id" IS NULL')
      .orderBy('s."totalScore"', 'DESC')
      .getOneOrFail();

    return {
      courseTaskId: task.courseTaskId,
      studentId: task.studentId,
    };
  }

  public async getRandomTask(mentorId: number, courseId: number) {
    const { courseTaskId, studentId } = await this.getRandomSolution(courseId);

    if (courseTaskId && studentId) {
      const checker: Partial<TaskChecker> = {
        courseTaskId,
        studentId,
        mentorId,
      };

      return await this.taskCheckerRepository.insert(checker);
    }

    throw new NotFoundException();
  }

  public async getMentorOptions(mentorId: number) {
    return this.mentorsRepository.findOne({
      where: { id: mentorId },
      select: {
        students: {
          id: true,
          user: {
            githubId: true,
          },
        },
      },
      relations: {
        students: {
          user: true,
        },
      },
    }) as Promise<
      | (Omit<Mentor, 'students'> & {
          students: (Student & { user: { githubId: string; firstName: string; lastName: string } })[];
        })
      | null
    >;
  }
}
