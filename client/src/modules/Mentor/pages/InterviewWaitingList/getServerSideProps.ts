import { CoursesApi, CoursesInterviewsApi, TaskDtoTypeEnum } from 'api';
import { notAuthorizedResponse, noAccessResponse } from 'modules/Course/data';
import { GetServerSideProps } from 'next';
import type { PageProps } from './index';
import { getApiConfiguration } from 'utils/axios';
import { getTokenFromContext } from 'utils/server';
import dayjs from 'dayjs';

export const getServerSideProps: GetServerSideProps<PageProps> = async ctx => {
  try {
    const alias = ctx.query.course as string;
    const interviewId = ctx.query.interviewId as string;

    if (!interviewId) {
      return {
        notFound: true,
      };
    }

    const token = getTokenFromContext(ctx);
    const { data: courses } = await new CoursesApi(getApiConfiguration(token)).getCourses();
    const course = courses.find(course => course.alias === alias) ?? null;

    if (!course) {
      return notAuthorizedResponse;
    }

    const { data: interview } = await new CoursesInterviewsApi(getApiConfiguration(token)).getInterview(
      +interviewId,
      course.id,
    );

    if (!interview) {
      return notAuthorizedResponse;
    }

    const isStage = interview.type === TaskDtoTypeEnum.StageInterview;
    if (!isStage && dayjs(interview.startDate).isAfter(dayjs())) {
      return notAuthorizedResponse;
    }

    return {
      props: { course, interview },
    };
  } catch {
    return noAccessResponse;
  }
};
