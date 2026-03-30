#ifndef WAVE_SCOPE_FREESTANDING_SYS_QUEUE_H
#define WAVE_SCOPE_FREESTANDING_SYS_QUEUE_H

#include <stddef.h>

#define STAILQ_HEAD(name, type) \
struct name { \
  struct type *stqh_first; \
  struct type **stqh_last; \
}

#define STAILQ_HEAD_INITIALIZER(head) { NULL, &(head).stqh_first }

#define STAILQ_ENTRY(type) \
struct { \
  struct type *stqe_next; \
}

#define STAILQ_FIRST(head) ((head)->stqh_first)
#define STAILQ_EMPTY(head) (STAILQ_FIRST(head) == NULL)

#define STAILQ_INIT(head) \
do { \
  (head)->stqh_first = NULL; \
  (head)->stqh_last = &(head)->stqh_first; \
} while (0)

#define STAILQ_INSERT_TAIL(head, elm, field) \
do { \
  (elm)->field.stqe_next = NULL; \
  *(head)->stqh_last = (elm); \
  (head)->stqh_last = &(elm)->field.stqe_next; \
} while (0)

#define STAILQ_REMOVE_HEAD(head, field) \
do { \
  if (((head)->stqh_first = (head)->stqh_first->field.stqe_next) == NULL) { \
    (head)->stqh_last = &(head)->stqh_first; \
  } \
} while (0)

#define STAILQ_FOREACH(var, head, field) \
for ((var) = STAILQ_FIRST(head); (var) != NULL; (var) = (var)->field.stqe_next)

#endif
