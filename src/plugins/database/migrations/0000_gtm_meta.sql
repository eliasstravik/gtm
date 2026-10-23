-- The database plugin's own schema: gtm.meta holds the production stamp and the local database id, nothing else.
create schema if not exists gtm;
create table if not exists gtm.meta (key text primary key not null, value text not null);
